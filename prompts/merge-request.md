The merge request is in {{requestPath}}. It contains staged prose annotations and the PROSE.md rules, together with any supplementary sections.

**Accuracy outranks form. Never trade a fact for a shorter sentence.** Preserve every fact and technical distinction. Code comments must strictly match the code they describe.

When changing I18N text, update every language version together.

Merge requirements:

1. First use the read tool to view the file content, and understand the annotations against the rules. Quotes in the annotations are based on the version at review time; when they do not match the current content, the current content prevails.
2. Skip an annotation directly when you consider it inapplicable.
3. Make changes only within the scope the annotation pertains to; do not modify any additional content.
4. When a change involves descriptions of business content, **always** analyze the code and understand the context to ensure the change introduces no deviation.
5. When a change involves frontend strings, evaluate the change based on its display location.

Read that file in parts with the file tools and begin processing the merge.

**Before finishing, re-read every changed part and confirm its meaning still matches the code.**
