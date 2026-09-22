const LOGO_MAX_DIM = 256;
// The node rejects an inline logo whose WHOLE data-URI string exceeds 32 KiB
// (MAX_TOKEN_IMAGE_DATA_URI_BYTES in core/daemon). Aim a little under it.
const LOGO_MAX_DATA_URI_CHARS = 30 * 1024;
const LOGO_DIMS = [256, 192, 160, 128, 96];
const LOGO_QUALITIES = [0.85, 0.7, 0.5, 0.35];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Compress an image file to a square webp suitable for a token logo,
 * then return a data URI (data:image/webp;base64,...) ready for on-chain storage.
 */
export async function fileToLogoDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("File must be an image");
  }

  const bitmap = await createImageBitmap(file);
  const srcSize = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - srcSize) / 2;
  const sy = (bitmap.height - srcSize) / 2;

  try {
    for (const maxDim of LOGO_DIMS) {
      const dim = Math.min(srcSize, maxDim);
      const canvas = new OffscreenCanvas(dim, dim);
      const ctx = canvas.getContext("2d")!;
      // Center-crop to square
      ctx.drawImage(bitmap, sx, sy, srcSize, srcSize, 0, 0, dim, dim);
      for (const quality of LOGO_QUALITIES) {
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        const dataUri = `data:image/webp;base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
        if (dataUri.length <= LOGO_MAX_DATA_URI_CHARS) return dataUri;
      }
      if (dim < maxDim) break; // source is already smaller than this step
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Image is too detailed to fit the 32 KB on-chain limit — use a simpler logo or host it and paste a URL");
}
