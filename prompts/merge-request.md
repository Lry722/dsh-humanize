The merge request is in {{requestPath}}. It contains staged prose annotations.

**Accuracy outranks form. Never trade a fact for a shorter sentence.** Preserve every fact, condition, exception, scope, guarantee, negation, qualifier, and technical distinction. Code comments must strictly match the code they describe.

**Before you cut a clause, check what fact it carries.** If the fact is not stated elsewhere in the same paragraph, keep it and rephrase. This applies to:

- why a value is shown (for example, a current value that is not in the published list);
- what a queue, file, or mode guarantees (for example, entries do not overwrite each other);
- what a mode deliberately does not do (for example, a full review adds no markers);
- conditions, exceptions, and scope.

**Do not remove a negation just because it is negative.** Keep the distinction or rewrite it positively without losing it.

When changing I18N text, update every language version together.

**Before finishing, re-read every changed part and confirm its meaning has not changed.** Check that every deleted clause did not carry the only statement of a fact.

Merge requirements:

1. First use the read tool to view the file content, and understand the annotations against the rules. Quotes in the annotations are based on the version at review time; when they do not match the current content, the current content prevails.
2. Skip an annotation directly when you consider it inapplicable.
3. Only make the prose changes required by the annotations. When done, report the result in a few concise sentences.
4. When a change involves descriptions of business content, **always** analyze the code and understand the context to ensure the change introduces no deviation.

Read that file in parts with the file tools and begin processing the merge.
