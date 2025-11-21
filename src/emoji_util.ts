// eslint-disable-next-line @typescript-eslint/no-var-requires
const emojiJson = require("unicode-emoji-json");

// Create a map of emoji -> slug
const emojiToSlug = new Map<string, string>();
const slugToEmoji = new Map<string, string>();

// Re-writing based on standard unicode-emoji-json structure
// It exports an object where keys are the emoji characters.
const emojis = emojiJson as Record<string, { name: string; slug: string; group: string }>;

for (const [char, data] of Object.entries(emojis)) {
    emojiToSlug.set(char, data.slug);
    slugToEmoji.set(data.slug, char);
}

export function unemojify(str: string): string {
    // Replace all emojis in the string with :slug:
    // We need a regex to match all emojis.
    // Since we have a map of all emojis, we can construct a regex or iterate.
    // Iterating over all emojis for every string is slow.
    // A better way is to match characters that look like emojis.
    // Or, since we are replacing `node-emoji`, we can try to match what it did.
    // But `unicode-emoji-json` doesn't provide a regex.

    // Simple approach: Iterate through the string and check if characters match known emojis.
    // But emojis can be multi-codepoint.
    // A regex constructed from all emoji keys is the most robust way, but might be huge.

    // Let's try to use a regex for emoji ranges and then look up in the map.
    // Or, we can use the `emoji-regex` package if we had it, but we don't want to add more deps if possible.

    // Wait, `node-emoji` did `s.replace(emojiRegex, ...)`

    // Let's try a simple replacement loop for now, or construct a regex from the keys.
    // There are ~3000 emojis. A regex with 3000 alternatives is big but manageable.
    // We should sort by length descending to match longest first (e.g. keycap sequences).

    return str.replace(emojiRegex, (match) => {
        const slug = emojiToSlug.get(match);
        return slug ? `:${slug}:` : match;
    });
}

// Constructing the regex once
const sortedEmojis = Array.from(emojiToSlug.keys()).sort((a, b) => b.length - a.length);
// Escape special regex characters in emojis? Emojis usually don't contain regex specials except maybe * or # in keycaps.
const emojiRegexPattern = sortedEmojis.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const emojiRegex = new RegExp(emojiRegexPattern, "g");

export function get(slug: string): string | undefined {
    // node-emoji.get() handles ":slug:" and "slug"
    const cleanSlug = slug.replace(/^:|:$/g, "");
    return slugToEmoji.get(cleanSlug);
}
