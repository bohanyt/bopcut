mod context;

use thiserror::Error;

pub use context::GpuContext;
pub use wgpu;

pub const GPU_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
pub const FULLSCREEN_SHADER_SOURCE: &str = include_str!("shaders/fullscreen.wgsl");

#[derive(Debug, Error)]
pub enum GpuError {
    #[error("No WebGPU adapter is available")]
    AdapterUnavailable,
    #[error("Failed to request a WebGPU device: {0}")]
    RequestDevice(#[from] wgpu::RequestDeviceError),
    #[error("Failed to create a WebGPU surface: {0}")]
    CreateSurface(#[from] wgpu::CreateSurfaceError),
    #[error("The output surface does not support the required texture format")]
    UnsupportedSurfaceFormat,
    #[error("The graphics surface was lost")]
    SurfaceLost,
    #[error("The graphics surface is temporarily unavailable")]
    SurfaceUnavailable,
    #[error("Graphics surface validation failed")]
    SurfaceValidation,
    #[error("WebGL2 operation failed: {0}")]
    WebGlOperation(String),
    #[error("Could not read the source canvas for texture upload")]
    CanvasRead,
    #[error("WebGPU initialization failed ({webgpu}); WebGL2 initialization failed ({webgl})")]
    BackendsUnavailable { webgpu: String, webgl: String },
}
