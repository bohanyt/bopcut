use std::collections::HashMap;

use gpu::{GpuContext, GpuError, wgpu};

type TextureKey = (u32, u32);

#[derive(Default)]
pub struct TexturePool {
    available: HashMap<TextureKey, Vec<wgpu::Texture>>,
    in_use: Vec<(TextureKey, wgpu::Texture)>,
}

impl TexturePool {
    pub fn recycle_frame(&mut self) {
        for (key, texture) in self.in_use.drain(..) {
            self.available.entry(key).or_default().push(texture);
        }
    }

    pub fn acquire(
        &mut self,
        context: &GpuContext,
        width: u32,
        height: u32,
        label: &'static str,
    ) -> Result<wgpu::Texture, GpuError> {
        let key = (width, height);
        let texture = match self.available.get_mut(&key).and_then(Vec::pop) {
            Some(texture) => texture,
            None => context.create_render_texture(width, height, label)?,
        };
        self.in_use.push((key, texture.clone()));
        Ok(texture)
    }
}
