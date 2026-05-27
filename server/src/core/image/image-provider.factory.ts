import type { AppSettings } from '@rpgspeak/shared';
import type { ImageProvider } from './image-provider.interface.js';
import { ComfyUiImageProvider }     from './providers/comfyui.image-provider.js';
import { PollinationsImageProvider } from './providers/pollinations.image-provider.js';
import { GeminiImageProvider }      from './providers/gemini.image-provider.js';
import { FalImageProvider }         from './providers/fal.image-provider.js';

export function createImageProvider(settings: AppSettings): ImageProvider {
  const provider = settings.imageProvider ?? 'comfyui';

  switch (provider) {
    case 'pollinations':
      return new PollinationsImageProvider(settings.pollinationsModel ?? undefined);

    case 'gemini':
      return new GeminiImageProvider(
        settings.imageProviderApiKey ?? '',
        settings.geminiModel ?? undefined,
      );

    case 'fal':
      return new FalImageProvider(
        settings.imageProviderApiKey ?? '',
        settings.falModel ?? undefined,
      );

    case 'comfyui':
    default:
      return new ComfyUiImageProvider(settings.comfyUiUrl ?? 'http://127.0.0.1:8000');
  }
}
