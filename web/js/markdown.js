// Markdown export compatible with Obsidian: frontmatter, [[wikilinks]] for
// connections and concepts, one file per note.
export function fileName(note) {
    const base = (note.title || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return `${base || 'Untitled'}.md`;
}

function yamlString(value) {
    return JSON.stringify(String(value || ''));
}

export function toMarkdown(note, notesById) {
    const linkTo = (id) => {
        const target = notesById.get(id);
        return target ? `[[${fileName(target).replace(/\.md$/, '')}]]` : null;
    };
    const lines = [
        '---',
        `title: ${yamlString(note.title)}`,
        `source: ${yamlString(note.source?.url)}`,
        `type: ${note.source?.sourceType || 'text'}`,
        note.source?.author ? `author: ${yamlString(note.source.author)}` : null,
        `captured: ${note.createdAt}`,
        `tags: [${(note.tags || []).map(yamlString).join(', ')}]`,
        '---',
        '',
        `# ${note.title}`,
        '',
        `> ${note.tldr}`,
        ''
    ].filter((line) => line !== null);

    if (note.summary?.length) {
        lines.push('## Summary', '');
        note.summary.forEach((section) => lines.push(`### ${section.heading}`, '', section.body, ''));
    }
    if (note.outline?.length) {
        lines.push('## Outline', '');
        note.outline.forEach((item) => lines.push(`${'  '.repeat(item.level - 1)}- ${item.text}`));
        lines.push('');
    }
    if (note.takeaways?.length) {
        lines.push('## Takeaways', '');
        note.takeaways.forEach((t) => lines.push(`- ${t}`));
        lines.push('');
    }
    if (note.concepts?.length) {
        lines.push('## Concepts', '');
        note.concepts.forEach((c) => lines.push(`- [[${c.name}]]: ${c.description}`));
        lines.push('');
    }
    const links = (note.connections || []).map((c) => {
        const link = linkTo(c.noteId);
        return link ? `- ${link} (${c.relation}): ${c.reason}` : null;
    }).filter(Boolean);
    if (links.length) {
        lines.push('## Connections', '', ...links, '');
    }
    if (note.quotes?.length) {
        lines.push('## Quotes', '');
        note.quotes.forEach((q) => lines.push(`> ${q}`, ''));
    }
    if (note.userNotes?.trim()) {
        lines.push('## My notes', '', note.userNotes.trim(), '');
    }
    return lines.join('\n');
}
