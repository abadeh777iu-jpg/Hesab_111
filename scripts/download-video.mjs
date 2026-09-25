/** Download the requested original. The home route automatically prefers it when present. */
import { mkdir, writeFile } from "node:fs/promises";

const url =
  "https://cdn.sceneai.art/Hero%20Section%20Video/1bcc8fa3-37f6-4c53-8591-0347e4c7f8ac.mp4";
const destination = new URL("../src/assets/hero-gradient.mp4", import.meta.url);
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`Video server returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.toString("ascii", 4, 8) !== "ftyp")
    throw new Error("The response was not an MP4 video");
  await mkdir(new URL("../src/assets/", import.meta.url), { recursive: true });
  await writeFile(destination, bytes);
  console.log(
    `Saved original video to ${destination.pathname} (${bytes.length.toLocaleString()} bytes).`,
  );
} catch (error) {
  console.error(
    `Could not download the original video: ${error.message}. The included local fallback remains available.`,
  );
  process.exitCode = 1;
}
