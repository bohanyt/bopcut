#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use compositor::{Compositor, CompositorError, FrameDescriptor, RenderFrameOptions};
use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    gpu_error_to_js, import_canvas_texture, read_offscreen_canvas_property, read_serde_property, read_u32_property,
    with_gpu_runtime,
};
use crate::perf;

struct CompositorRuntime {
    canvas: web_sys::HtmlCanvasElement,
    compositor: Compositor,
    surface: Option<wgpu::Surface<'static>>,
    surface_size: (u32, u32),
}

thread_local! {
    static COMPOSITOR_RUNTIME: RefCell<Option<CompositorRuntime>> = const { RefCell::new(None) };
}

pub(crate) fn reset_compositor() {
    COMPOSITOR_RUNTIME.with(|runtime| runtime.replace(None));
}

#[wasm_bindgen(js_name = initCompositor)]
pub fn init_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        gpu_runtime.context.validate_dimensions(width, height).map_err(gpu_error_to_js)?;
        // The GL context owns its surface. Only WebGPU needs a separate one.
        let canvas = if let Some(gl_canvas) = gpu_runtime.context.gl_canvas() {
            gl_canvas.clone()
        } else {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is not available"))?;
            document
                .create_element("canvas")?
                .dyn_into::<web_sys::HtmlCanvasElement>()
                .map_err(|_| JsValue::from_str("Failed to create compositor canvas"))?
        };
        let compositor = Compositor::new(&gpu_runtime.context);
        gpu_runtime.context.check_error().map_err(gpu_error_to_js)?;
        let surface = if gpu_runtime.context.gl_canvas().is_none() {
            canvas.set_width(width);
            canvas.set_height(height);
            let surface = gpu_runtime
                .context
                .instance()
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            gpu_runtime.context.configure_surface(&surface, width, height).map_err(gpu_error_to_js)?;
            Some(surface)
        } else {
            None
        };

        COMPOSITOR_RUNTIME.with(|runtime| {
            runtime.replace(Some(CompositorRuntime {
                canvas,
                compositor,
                surface,
                surface_size: (width, height),
            }));
        });

        Ok(())
    })
}

#[wasm_bindgen(js_name = resizeCompositor)]
pub fn resize_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };
            configure_surface(gpu_runtime, runtime, width, height)
        })
    })
}

fn configure_surface(
    gpu_runtime: &crate::gpu::GpuRuntime,
    runtime: &mut CompositorRuntime,
    width: u32,
    height: u32,
) -> Result<(), JsValue> {
    gpu_runtime.context.validate_dimensions(width, height).map_err(gpu_error_to_js)?;
    if let Some(surface) = &runtime.surface
        && runtime.surface_size != (width, height)
    {
        runtime.canvas.set_width(width);
        runtime.canvas.set_height(height);
        gpu_runtime.context.configure_surface(surface, width, height).map_err(gpu_error_to_js)?;
        runtime.surface_size = (width, height);
    }
    Ok(())
}

#[wasm_bindgen(js_name = getCompositorCanvas)]
pub fn get_compositor_canvas() -> Result<web_sys::HtmlCanvasElement, JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let borrow = runtime.borrow();
        let Some(runtime) = borrow.as_ref() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        Ok(runtime.canvas.clone())
    })
}

#[wasm_bindgen(js_name = uploadTexture)]
pub fn upload_texture(options: JsValue) -> Result<(), JsValue> {
    let UploadTextureOptions {
        id,
        source,
        width,
        height,
        is_mask,
    } = parse_upload_texture_options(options)?;

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            let texture = import_canvas_texture(
                &gpu_runtime.context,
                &source,
                width,
                height,
                !is_mask,
                "compositor-upload-texture",
            )?;
            runtime.compositor.upsert_texture(id, texture);
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = releaseTexture)]
pub fn release_texture(id: String) -> Result<(), JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let mut borrow = runtime.borrow_mut();
        let Some(runtime) = borrow.as_mut() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        runtime.compositor.release_texture(&id);
        Ok(())
    })
}

#[wasm_bindgen(js_name = renderFrame)]
pub fn render_frame(options: JsValue) -> Result<(), JsValue> {
    perf::reset();

    let t_deserialize = perf::now_ms();
    let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;
    perf::record("wasm.deserialize", perf::now_ms() - t_deserialize);

    with_gpu_runtime(|gpu_runtime| {
        gpu_runtime.context.validate_dimensions(frame.width, frame.height).map_err(gpu_error_to_js)?;
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            if let Some(surface) = &runtime.surface {
                if runtime.surface_size != (frame.width, frame.height) {
                    let t_surface = perf::now_ms();
                    runtime.canvas.set_width(frame.width);
                    runtime.canvas.set_height(frame.height);
                    gpu_runtime.context.configure_surface(surface, frame.width, frame.height).map_err(gpu_error_to_js)?;
                    perf::record("wasm.surfaceConfigure", perf::now_ms() - t_surface);
                    runtime.surface_size = (frame.width, frame.height);
                }
                let t_render = perf::now_ms();
                let result = runtime
                    .compositor
                    .render_frame(
                        &gpu_runtime.context,
                        RenderFrameOptions {
                            frame: &frame,
                            surface,
                        },
                    )
                    .map_err(|error| match error {
                        CompositorError::Gpu(error) => gpu_error_to_js(error),
                        _ => JsValue::from_str(&error.to_string()),
                    });
                perf::record("wasm.renderFrameToSurface", perf::now_ms() - t_render);
                result
            } else {
                // WebGL shares one staging surface with effect and mask rendering.
                let t_composite = perf::now_ms();
                let texture = runtime
                    .compositor
                    .render_frame_to_texture(&gpu_runtime.context, &frame)
                    .map_err(|error| JsValue::from_str(&error.to_string()));
                if let Err(error) = gpu_runtime.context.check_render_result("frame compositing") {
                    runtime.compositor.discard_temporary_textures();
                    return Err(gpu_error_to_js(error));
                }
                let texture = texture?;
                perf::record("wasm.compositeToTexture", perf::now_ms() - t_composite);

                let t_present = perf::now_ms();
                gpu_runtime
                    .context
                    .render_texture_to_gl_canvas_surface(&texture, frame.width, frame.height)
                    .map_err(gpu_error_to_js)?;
                perf::record("wasm.presentToSurface", perf::now_ms() - t_present);

                Ok(())
            }
        })
    })
}

#[derive(Debug)]
struct UploadTextureOptions {
    id: String,
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    is_mask: bool,
}

fn parse_upload_texture_options(value: JsValue) -> Result<UploadTextureOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTexture expects an options object"))?;

    Ok(UploadTextureOptions {
        id: read_serde_property(&object, "id")?,
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
        is_mask: read_serde_property::<Option<bool>>(&object, "isMask")?.unwrap_or(false),
    })
}
