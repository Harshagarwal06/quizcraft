// Polyfills for pdfjs-dist used by pdf-parse in Node environments
// Prevents "ReferenceError: DOMMatrix is not defined" when rendering is not needed.

if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {} as any;
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {} as any;
}
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {} as any;
}
