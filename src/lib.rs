// SPDX-FileCopyrightText: 2026 Jandira Technologies, LLC
//
// SPDX-License-Identifier: Apache-2.0

//! DOCX to PDF, and nothing else, for WebAssembly.
//!
//! The module exports one function, `docxToPdf`. It wraps
//! [`jubarte_render::convert::docx_to_pdf_with`], whose Carlito and
//! Liberation font files are compiled into the binary, so a conversion
//! needs no font from the host and no network.

use jubarte_render::convert::{CommentPlacement, PdfOptions, RevisionStyle, docx_to_pdf_with};
use wasm_bindgen::prelude::*;

/// The conversion behind `docxToPdf`, with a plain error so it also runs
/// off WebAssembly.
///
/// # Errors
///
/// A message when `revisions` or `revision_palette` is not a known choice,
/// or when `docx` is not a DOCX package the renderer can open.
pub fn convert(
    docx: &[u8],
    compress: bool,
    revisions: &str,
    revision_palette: Option<&str>,
    comments_at_end: bool,
    changed_only: bool,
) -> Result<Vec<u8>, String> {
    let options = PdfOptions {
        compress,
        revisions: RevisionStyle::from_choice(revisions, revision_palette)?,
        comments: if comments_at_end {
            CommentPlacement::End
        } else {
            CommentPlacement::Margin
        },
        comment_notes: false,
        changed_only,
    };
    docx_to_pdf_with(docx, options).map_err(|error| error.to_string())
}

/// Render a DOCX package to PDF.
///
/// `revisions` is `"conventional"`, `"word"` or `"custom"` (with
/// `revisionPalette`, such as `"deleted=#AA0000:strike"`). `commentsAtEnd`
/// lists the comments after the last page instead of beside the text.
/// `changedOnly` keeps only the pages a tracked change or a comment
/// touches.
///
/// # Errors
///
/// A JavaScript `Error` carrying the message of [`convert`].
#[wasm_bindgen(js_name = docxToPdf)]
pub fn docx_to_pdf(
    docx: &[u8],
    compress: bool,
    revisions: &str,
    revision_palette: Option<String>,
    comments_at_end: bool,
    changed_only: bool,
) -> Result<Vec<u8>, JsError> {
    convert(
        docx,
        compress,
        revisions,
        revision_palette.as_deref(),
        comments_at_end,
        changed_only,
    )
    .map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::convert;

    #[test]
    fn bytes_that_are_not_a_docx_are_refused_with_a_message() {
        let error = convert(b"not a zip", true, "conventional", None, false, false)
            .expect_err("garbage is not a document");
        assert!(!error.is_empty());
    }

    #[test]
    fn an_unknown_revision_style_is_refused_before_any_work() {
        let error =
            convert(b"", true, "rainbow", None, false, false).expect_err("rainbow is not a style");
        assert!(error.contains("rainbow"), "{error}");
    }
}
