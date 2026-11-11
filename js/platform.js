// Laufzeitumgebung: normale Website oder Claude-Chat (Artifact).
// Im Chat stellt der Viewer `window.claude` bereit; dort sind Kamera-Livebild und
// externe Server gesperrt, dafür gibt es KI über das Claude-Konto und einen Datenspeicher.
export const IN_CLAUDE = typeof window !== "undefined" && !!window.claude && typeof window.claude.use === "function";

/** Capability-Namespace oder null (nie werfend). */
export async function capability(name) {
  if (!IN_CLAUDE) return null;
  try { return await window.claude.use(name); } catch { return null; }
}
