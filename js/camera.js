// Kamera: Barcode-Scan (native BarcodeDetector, sonst ZXing) und Fotoaufnahme.
import { validGtin } from "./off.js";

let zxingMod = null;
async function zxing() { return (zxingMod ||= await import("../vendor/zxing.mjs")); }

export function cameraSupported() { return !!navigator.mediaDevices?.getUserMedia; }

function camError(e) {
  if (!window.isSecureContext) return new Error("Kamera nur über HTTPS (oder localhost) verfügbar.");
  if (e?.name === "NotAllowedError") return new Error("Kamerazugriff wurde verweigert. Bitte in den Browser-Einstellungen erlauben.");
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") return new Error("Keine Kamera gefunden.");
  if (e?.name === "NotReadableError") return new Error("Kamera wird bereits von einer anderen App verwendet.");
  return new Error("Kamera konnte nicht gestartet werden: " + (e?.message || e));
}

export async function startStream(video, { facingMode = "environment", width = 1920, height = 1080 } = {}) {
  if (!cameraSupported()) throw camError({ name: "NotFoundError" });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: width }, height: { ideal: height } } });
  } catch (e) { throw camError(e); }
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});
  return stream;
}
export function stopStream(stream) { stream?.getTracks().forEach((t) => t.stop()); }

/**
 * Startet einen kontinuierlichen Barcode-Scan auf einem laufenden Video.
 * onCode wird einmal mit einem gültigen (Prüfziffer!) EAN/UPC aufgerufen. Gibt stop() zurück.
 */
export async function scanBarcodes(video, onCode) {
  let stopped = false;
  const hits = new Map(); // Code muss zweimal gelesen werden -> weniger Fehlerkennungen
  const accept = (raw) => {
    let code = String(raw).replace(/\D/g, "");
    if (code.length === 12) code = "0" + code; // UPC-A -> EAN-13
    if (!validGtin(code)) return;
    const c = (hits.get(code) || 0) + 1;
    hits.set(code, c);
    if (c >= 2 && !stopped) { stopped = true; onCode(code); }
  };

  if ("BarcodeDetector" in window) {
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats();
      const want = ["ean_13", "ean_8", "upc_a", "upc_e"].filter((f) => fmts.includes(f));
      if (want.length) {
        const det = new window.BarcodeDetector({ formats: want });
        const loop = async () => {
          if (stopped) return;
          if (video.readyState >= 2) {
            try { for (const b of await det.detect(video)) accept(b.rawValue); } catch {}
          }
          setTimeout(loop, 120);
        };
        loop();
        return () => { stopped = true; };
      }
    } catch {}
  }

  const { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } = await zxing();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
  const controls = await reader.decodeFromVideoElement(video, (result) => { if (result && !stopped) accept(result.getText()); });
  return () => { stopped = true; try { controls.stop(); } catch {} };
}

/** Barcode aus einem Standbild lesen (Upload). */
export async function decodeImageBarcode(img) {
  if ("BarcodeDetector" in window) {
    try {
      const det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      const r = await det.detect(img);
      for (const b of r) { let c = b.rawValue.replace(/\D/g, ""); if (c.length === 12) c = "0" + c; if (validGtin(c)) return c; }
    } catch {}
  }
  try {
    const { BrowserMultiFormatReader } = await zxing();
    const res = await new BrowserMultiFormatReader().decodeFromImageElement(img);
    let c = res.getText().replace(/\D/g, ""); if (c.length === 12) c = "0" + c;
    return validGtin(c) ? c : null;
  } catch { return null; }
}

/** Aktuelles Videobild als JPEG-Blob. */
export function grabFrame(video) {
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
}

/**
 * Bild auf max. 1568 px (lange Kante) verkleinern und als Base64-JPEG liefern
 * (empfohlene Größe für die Bildanalyse; spart Übertragung und Kosten).
 */
export async function prepareImage(blob, maxSide = 1568) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Bild konnte nicht gelesen werden.")); i.src = url; });
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.88);
    return { dataUrl, base64: dataUrl.split(",")[1], mediaType: "image/jpeg", img };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
