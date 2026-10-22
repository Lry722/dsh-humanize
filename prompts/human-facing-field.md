Judge what this call writes, not the file name or extension.

Use true when the call adds, changes, moves, or deletes text meant for people to read: documents, prose, user-facing strings, messages, translations, and comments in any language, including file headers, doc comments, and inline explanations. Formatting-only changes to such text are also human-facing. A write that changes only a comment in an otherwise code-heavy file is human-facing.

Use false only when the call touches nothing but code or data: logic, structure, names, formatting of code, or machine-readable data with no human-readable text. Deleting only code is not human-facing.

If the content mixes code and comments, or you are unsure, use true.

Examples:

- Updating a README, doc comment, inline comment, error message, or translation: true.
- Refactoring code, renaming a variable, or editing a package manifest with no human-readable text: false.
