#![cfg(target_arch = "wasm32")]

use std::cell::{Cell, RefCell};
use std::sync::Arc;

use effects::EffectPipeline;
use gpu::{GpuContext, GpuError, wgpu};
use js_sys::{Function, Object, Reflect};
use masks::MaskFeatherPipeline;
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

pub(crate) struct GpuRuntime {
    pub(crate) context: GpuContext,
    pub(crate) effects: EffectPipeline,
    pub(crate) masks: MaskFeatherPipeline,
}

thread_local! {
    static GPU_RUNTIME: RefCell<Option<GpuRuntime>> = const { RefCell::new(None) };
    static DEVICE_ID: Cell<u32> = const { Cell::new(0) };
    static ON_DEVICE_LOST: RefCell<Option<Function>> = const { RefCell::new(None) };
}

fn set_panic_hook() {
    static SET_HOOK: std::sync::Once = std::sync::Once::new();
    SET_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            // Store the full panic message in window.__wasmPanic so the JS catch block
            // can surface it instead of the opaque "Unreachable" WASM trap message.
            if let Some(window) = web_sys::window() {
                let _ = Reflect::set(
                    &window,
                    &JsValue::from_str("__wasmPanic"),
                    &JsValue::from_str(&info.to_string()),
                );
            }
            console_error_panic_hook::hook(info);
        }));
    });
}

#[wasm_bindgen(js_name = initializeGpu)]
pub async fn initialize_gpu(on_device_lost: Option<Function>) -> Result<(), JsValue> {
    set_panic_hook();

    if GPU_RUNTIME.with(|runtime| runtime.borrow().is_some()) {
        return Ok(());
    }

    let context = GpuContext::new()
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let device_id = DEVICE_ID.with(Cell::get);
    ON_DEVICE_LOST.with(|callback| callback.replace(on_device_lost));
    if context.gl_canvas().is_none() {
        context.device().set_device_lost_callback(move |_, _| {
            if DEVICE_ID.with(Cell::get) == device_id {
                let callback = ON_DEVICE_LOST.with(|callback| callback.borrow().clone());
                if let Some(callback) = callback {
                    let _ = callback.call0(&JsValue::UNDEFINED);
                }
            }
        });
    }
    context.device().on_uncaptured_error(Arc::new(|error| {
        web_sys::console::error_1(&JsValue::from_str(&error.to_string()));
    }));
    let effects = EffectPipeline::new(&context);
    let masks = MaskFeatherPipeline::new(&context);

    GPU_RUNTIME.with(|runtime| {
        runtime.replace(Some(GpuRuntime {
            context,
            effects,
            masks,
        }));
    });

    Ok(())
}

#[wasm_bindgen(js_name = resetGpu)]
pub fn reset_gpu() {
    DEVICE_ID.with(|id| id.set(id.get().wrapping_add(1)));
    ON_DEVICE_LOST.with(|callback| callback.replace(None));
    crate::compositor::reset_compositor();
    if let Some(runtime) = GPU_RUNTIME.with(|runtime| runtime.replace(None))
        && runtime.context.gl_canvas().is_none()
    {
        runtime.context.device().destroy();
    }
}

#[wasm_bindgen(js_name = getGpuWebGlCanvas)]
pub fn get_gpu_web_gl_canvas() -> Option<web_sys::HtmlCanvasElement> {
    GPU_RUNTIME.with(|runtime| runtime.borrow().as_ref()?.context.gl_canvas().cloned())
}

pub(crate) fn gpu_error_to_js(error: GpuError) -> JsValue {
    match error {
        GpuError::SurfaceLost => JsValue::from_str("GPU_SURFACE_LOST"),
        GpuError::SurfaceUnavailable => JsValue::from_str("GPU_SURFACE_UNAVAILABLE"),
        _ => js_sys::Error::new(&error.to_string()).into(),
    }
}

pub(crate) fn with_gpu_runtime<T>(
    action: impl FnOnce(&GpuRuntime) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    GPU_RUNTIME.with(|runtime| {
        let borrow = runtime.borrow();
        let Some(gpu_runtime) = borrow.as_ref() else {
            return Err(JsValue::from_str(
                "GPU context not initialized. Call initializeGpu() first.",
            ));
        };
        action(gpu_runtime)
    })
}

pub(crate) fn import_canvas_texture(
    context: &GpuContext,
    canvas: &wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    label: &'static str,
) -> wgpu::Texture {
    context.import_offscreen_canvas_texture(canvas, width, height, label)
}

pub(crate) fn render_texture_to_canvas(
    context: &GpuContext,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let canvas = wgpu::web_sys::OffscreenCanvas::new(width, height)?;
    context
        .render_texture_to_offscreen_canvas(texture, &canvas, width, height)
        .map_err(gpu_error_to_js)?;
    Ok(canvas)
}

pub(crate) fn read_property(object: &Object, name: &str) -> Result<JsValue, JsValue> {
    Reflect::get(object, &JsValue::from_str(name))
        .map_err(|_| JsValue::from_str(&format!("Missing property '{name}'")))
}

pub(crate) fn read_offscreen_canvas_property(
    object: &Object,
    name: &str,
) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    read_property(object, name)?
        .dyn_into::<wgpu::web_sys::OffscreenCanvas>()
        .map_err(|_| JsValue::from_str(&format!("Property '{name}' must be an OffscreenCanvas")))
}

pub(crate) fn read_u32_property(object: &Object, name: &str) -> Result<u32, JsValue> {
    let value = read_property(object, name)?;
    let Some(number) = value.as_f64() else {
        return Err(JsValue::from_str(&format!(
            "Property '{name}' must be a number"
        )));
    };
    Ok(number as u32)
}

pub(crate) fn read_f32_property(object: &Object, name: &str) -> Result<f32, JsValue> {
    let value = read_property(object, name)?;
    let Some(number) = value.as_f64() else {
        return Err(JsValue::from_str(&format!(
            "Property '{name}' must be a number"
        )));
    };
    Ok(number as f32)
}

pub(crate) fn read_serde_property<T>(object: &Object, name: &str) -> Result<T, JsValue>
where
    T: for<'de> Deserialize<'de>,
{
    let value = read_property(object, name)?;
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&format!("Invalid property '{name}': {error}")))
}
