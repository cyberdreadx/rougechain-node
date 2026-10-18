import { describe, expect, it } from "vitest";
import { addFile, addFolder, buildTree, deletePath, mainFile, nameProblem, renameIn, renamePath, type Workspace } from "./workspace";

const ws: Workspace = { files: { "src/lib.rs": "lib", "src/pool.rs": "pool", "Cargo.toml": "toml" }, folders: [] };
const shape = (w: Workspace) => JSON.stringify(buildTree(w), (k, v) => (k === "children" && !v.length ? undefined : k === "path" || k === "folder" ? undefined : v));

describe("IDE workspace files", () => {
  it("builds a tree with folders first", () => {
    expect(shape(ws)).toBe('[{"name":"src","children":[{"name":"lib.rs"},{"name":"pool.rs"}]},{"name":"Cargo.toml"}]');
    expect(mainFile(ws)).toBe("src/lib.rs");
  });

  it("adds files and empty folders", () => {
    const w = addFolder(addFile(ws, "src/util.rs", "u"), "tests");
    expect(w.files["src/util.rs"]).toBe("u");
    expect(shape(w)).toContain('{"name":"tests"}');
    expect(addFile(w, "tests/a.rs").folders).toEqual([]);
  });

  it("renames a folder with everything in it, and the open tabs", () => {
    const w = renamePath(addFolder(ws, "src/empty"), "src", "code");
    expect(Object.keys(w.files).sort()).toEqual(["Cargo.toml", "code/lib.rs", "code/pool.rs"]);
    expect(w.folders).toEqual(["code/empty"]);
    expect(renameIn(["src/lib.rs", "Cargo.toml"], "src", "code")).toEqual(["code/lib.rs", "Cargo.toml"]);
  });

  it("deletes files and folders, keeping an emptied parent", () => {
    const one = deletePath(deletePath(ws, "src/lib.rs"), "src/pool.rs");
    expect(Object.keys(one.files)).toEqual(["Cargo.toml"]);
    expect(one.folders).toEqual(["src"]);
    expect(Object.keys(deletePath(ws, "src").files)).toEqual(["Cargo.toml"]);
  });

  it("checks names", () => {
    expect(nameProblem(ws, "src", "lib.rs")).toMatch(/already exists/);
    expect(nameProblem(ws, "src", "lib.rs", "src/lib.rs")).toBeNull();
    expect(nameProblem(ws, "", "a b")).toMatch(/letters/);
    expect(nameProblem(ws, "", "..")).toMatch(/reserved/);
    expect(nameProblem(ws, "", " ")).toMatch(/Enter a name/);
    expect(nameProblem(ws, "src", "new.rs")).toBeNull();
  });
});
