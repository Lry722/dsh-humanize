Judge what this call writes, not the file name or extension.

Use true when the written content contains text meant for humans to read: documents, prose, user-facing strings, and comments in any language, including file headers, doc comments, and inline explanations. A write that adds or changes a comment is human-facing even when most of it is code.

Use false only when the written content is entirely code or data: logic, structure, names, formatting, or machine-readable data with no human-readable text.

If the content mixes code and comments, or you are unsure, use true.
