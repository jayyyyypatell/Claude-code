import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import yauzl from "yauzl";

/**
 * Finding `export.xml` inside `export.zip` without unpacking the archive.
 *
 * The zip holds a few hundred megabytes of XML plus, usually, thousands of
 * workout route GPX files. Unzipping to disk first would need that much free
 * space and read everything twice, so the entry is opened as a stream and
 * piped straight into the parser.
 *
 * `lazyEntries` is what makes that possible: yauzl hands over one entry at a
 * time and waits, rather than firing an event per entry and buffering.
 */

/** Where Health.app puts the file. Older exports vary, hence the fallbacks. */
const XML_CANDIDATES = [
  "apple_health_export/export.xml",
  "export.xml",
  "apple_health_export/Export.xml",
];

export interface ZipEntryStream {
  stream: Readable;
  /** Uncompressed size, for progress. 0 when the archive doesn't record it. */
  uncompressedSize: number;
  entryName: string;
}

/**
 * Open the health export XML inside a zip.
 *
 * Rejects with a message naming what was actually in the archive — "no
 * export.xml" is a dead end when the real problem is that the user picked the
 * wrong zip, which is easy to do since Health.app names it generically.
 */
export function openHealthExportXml(zipPath: string): Promise<ZipEntryStream> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error(`Could not open ${zipPath} as a zip archive.`));
        return;
      }

      const seen: string[] = [];
      let settled = false;

      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(e);
      };

      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (seen.length < 20) seen.push(name);

        const isTarget =
          XML_CANDIDATES.includes(name) ||
          // A locale-renamed or nested export still ends in export.xml.
          /(^|\/)export\.xml$/i.test(name);

        if (!isTarget) {
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new Error(`Could not read ${name} from the archive.`));
            return;
          }
          settled = true;
          // The stream owns the archive handle now; closing it here would kill
          // the read mid-flight.
          stream.on("end", () => zip.close());
          resolve({
            stream: stream as unknown as Readable,
            uncompressedSize: entry.uncompressedSize ?? 0,
            entryName: name,
          });
        });
      });

      zip.on("end", () => {
        fail(
          new Error(
            `No export.xml inside ${zipPath}. Found: ${seen.slice(0, 10).join(", ") || "(nothing)"}. ` +
              "Health.app's export is a zip containing apple_health_export/export.xml — " +
              "if you exported from somewhere else this is probably the wrong file.",
          ),
        );
      });

      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/**
 * A readable for either a `.zip` or a bare `.xml`.
 *
 * Accepting the unzipped file matters more than it looks: when an import goes
 * wrong the first thing anyone does is unzip it to look inside, and being told
 * to re-zip it at that point is needless.
 */
export async function openHealthExport(path: string): Promise<ZipEntryStream> {
  if (/\.xml$/i.test(path)) {
    const info = await stat(path);
    return {
      stream: createReadStream(path),
      uncompressedSize: info.size,
      entryName: path,
    };
  }
  return openHealthExportXml(path);
}
