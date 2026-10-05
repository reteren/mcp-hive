import { describe, expect, it } from "vitest";
import { contentToBlocks, youtubeIdsIn } from "../src/content.js";
import { parseCaptions, youtubeVideoId } from "../src/youtube.js";

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["youtube.com/shorts/aqz-KE-bpKQ", "aqz-KE-bpKQ"],
    ["https://m.youtube.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://music.youtube.com/watch?v=jNQXAC9IVRw&list=RD", "jNQXAC9IVRw"],
    ["https://www.youtube.com/live/jNQXAC9IVRw?feature=share", "jNQXAC9IVRw"],
    ["https://www.youtube-nocookie.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["jNQXAC9IVRw", "jNQXAC9IVRw"],
  ])("%s", (input, id) => expect(youtubeVideoId(input)).toBe(id));

  it.each(["https://example.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/channel/UC123", "not a url", "https://youtu.be/short"])(
    "rejects %s", (input) => expect(youtubeVideoId(input)).toBeNull());
});

describe("parseCaptions", () => {
  it("reads timedtext format 3 with nested segments and entities", () => {
    const xml = `<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="1"><s>Hello</s><s> &amp; welcome</s></p><p t="2" d="1">it&#39;s   fine</p></body></timedtext>`;
    expect(parseCaptions(xml)).toBe("Hello & welcome it's fine");
  });
  it("reads legacy <text> transcripts", () => {
    expect(parseCaptions(`<transcript><text start="1">one &quot;two&quot;</text><text start="2">three</text></transcript>`)).toBe(`one "two" three`);
  });
  it("reads json3", () => {
    expect(parseCaptions(JSON.stringify({ events: [{ segs: [{ utf8: "a" }, { utf8: " b" }] }, {}, { segs: [{ utf8: "\n" }] }, { segs: [{ utf8: "c" }] }] }))).toBe("a b c");
  });
});

describe("contentToBlocks", () => {
  it("moves images out of the JSON into captioned image blocks", () => {
    const blocks = contentToBlocks({
      id: "n", name: "Pic", type: "note", text: "x",
      inlineImages: [{ file: "a.png", mime: "image/png", data: "AAAA", width: 10, height: 5 }],
      image: { file: "b.jpg", mime: "image/jpeg", data: "BBBB", width: 1, height: 1 },
    }, "Node Pic");
    expect(blocks.map((block) => block.type)).toEqual(["text", "text", "image", "text", "image"]);
    expect(blocks[0].type === "text" && blocks[0].text).not.toContain("AAAA");
    expect(blocks[2]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(blocks[3].type === "text" && blocks[3].text).toContain("b.jpg");
  });
});

describe("youtubeIdsIn", () => {
  it("collects ids from the youtube ref, links and raw text without duplicates", () => {
    expect(youtubeIdsIn({
      youtube: { videoId: "jNQXAC9IVRw" },
      links: [{ url: "https://youtu.be/dQw4w9WgXcQ", kind: "youtube" }],
      text: "see https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://example.com",
    })).toEqual(["jNQXAC9IVRw", "dQw4w9WgXcQ"]);
  });
});
