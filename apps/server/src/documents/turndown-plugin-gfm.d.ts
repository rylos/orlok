// The Joplin fork of the GFM plugin (maintained, handles headerless tables) ships no types.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  const plugin: {
    gfm: TurndownService.Plugin;
    highlightedCodeBlock: TurndownService.Plugin;
    strikethrough: TurndownService.Plugin;
    tables: TurndownService.Plugin;
    taskListItems: TurndownService.Plugin;
  };
  export default plugin;
}
