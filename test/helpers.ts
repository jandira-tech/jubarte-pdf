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

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const SECTION = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

const pack = (body: string, parts: Record<string, string> = {}): Uint8Array => {
  const extra = Object.keys(parts);
  const overrides = extra
    .map(
      (name) =>
        `<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${name}+xml"/>`,
    )
    .join("");
  const rels = extra
    .map(
      (name, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}" Target="${name}.xml"/>`,
    )
    .join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES.replace("</Types>", `${overrides}</Types>`)),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}"><w:body>${body}${SECTION}</w:body></w:document>`,
    ),
  };
  if (extra.length > 0) {
    files["word/_rels/document.xml.rels"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    );
  }
  for (const [name, xml] of Object.entries(parts)) {
    files[`word/${name}.xml`] = strToU8(xml);
  }
  return zipSync(files);
};

export type FontRun = { font: string; text: string; bold?: boolean; italic?: boolean };

/** A minimal DOCX with one paragraph per entry, each set in the named font and style. */
export const docxWithFonts = (paragraphs: readonly FontRun[]): Uint8Array =>
  pack(
    paragraphs
      .map(
        ({ font, text, bold = false, italic = false }) =>
          `<w:p><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}</w:rPr><w:t>${text}</w:t></w:r></w:p>`,
      )
      .join(""),
  );

const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/**
 * Five pages, each with a line naming it. Page three has a tracked insertion
 * and page four a comment; the other pages are untouched.
 */
export const fivePagesOneChangeOneComment = (): Uint8Array =>
  pack(
    [
      paragraph("Page one is untouched."),
      paragraph("Page two is untouched."),
      `<w:p><w:r><w:t xml:space="preserve">Page three has </w:t></w:r><w:ins w:id="1" w:author="Reviewer" w:date="2026-01-05T10:00:00Z"><w:r><w:t>an inserted phrase</w:t></w:r></w:ins></w:p>`,
      `<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Page four is commented.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>`,
      paragraph("Page five is untouched."),
    ].join(PAGE_BREAK),
    {
      comments: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Reviewer" w:date="2026-01-05T10:00:00Z" w:initials="R"><w:p><w:r><w:t>Please confirm this clause.</w:t></w:r></w:p></w:comment></w:comments>`,
    },
  );

/** The text of each page, as poppler extracts it. */
export const pdfPageTexts = (pdf: Uint8Array | ArrayBuffer): string[] => {
  const path = onDisk(pdf);
  return Array.from({ length: pdfPages(pdf) }, (_unused, index) =>
    execFileSync("pdftotext", ["-f", String(index + 1), "-l", String(index + 1), path, "-"], {
      encoding: "utf8",
    }),
  );
};
