// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Whether poppler's command-line tools are installed: they read our PDFs from outside. */
export const hasPoppler = spawnSync("pdffonts", ["-v"]).error === undefined;

const onDisk = (pdf: Uint8Array | ArrayBuffer): string => {
  const path = join(mkdtempSync(join(tmpdir(), "jubarte-pdf-")), "out.pdf");
  writeFileSync(path, new Uint8Array(pdf));
  return path;
};

/** The text poppler extracts from the PDF. */
export const pdfText = (pdf: Uint8Array | ArrayBuffer): string =>
  execFileSync("pdftotext", ["-layout", onDisk(pdf), "-"], { encoding: "utf8" });

/** The page count poppler reports. */
export const pdfPages = (pdf: Uint8Array | ArrayBuffer): number => {
  const info = execFileSync("pdfinfo", [onDisk(pdf)], { encoding: "utf8" });
  return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
};

export type PdfFont = { name: string; embedded: boolean };

/** The fonts poppler finds in the PDF, with whether each is embedded. */
export const pdfFonts = (pdf: Uint8Array | ArrayBuffer): PdfFont[] =>
  execFileSync("pdffonts", [onDisk(pdf)], { encoding: "utf8" })
    .split("\n")
    .slice(2)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      // name, type (one or two words), encoding, then emb sub uni as yes/no.
      const flags = /\s(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/.exec(line);
      return {
        // A subset font is named ABCDEF+Family.
        name: (line.split(/\s+/)[0] ?? "").replace(/^[A-Z]{6}\+/, ""),
        embedded: flags?.[1] === "yes",
      };
    });

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** A minimal DOCX with one paragraph per entry, each set in the named font. */
export const docxWithFonts = (
  paragraphs: readonly { font: string; text: string }[],
): Uint8Array => {
  const body = paragraphs
    .map(
      ({ font, text }) =>
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(document),
  });
};
