/** Client-side cover pre-validation before any bytes leave the browser. */
export function validateCoverFile(f: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const aspect = h / w;
      if (aspect < 1.2 || aspect > 1.5) {
        resolve(`Image is ${w}×${h} — covers must be portrait, close to 3:4 (e.g. 900×1200).`);
      } else if (w < 900 || h < 1200) {
        resolve(`Image is ${w}×${h}px — needs at least 900×1200px to stay sharp in the app.`);
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("The image couldn't be read. Use a JPEG, PNG, or WebP file.");
    };
    img.src = url;
  });
}
