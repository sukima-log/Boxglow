import { expect, it } from "vitest";
import { setLang } from "../i18n/core";
import { addBlock, answerDecision, askDecision, createProject, defaultTaskParent, finishBlock, setActivity } from "./graph";
import { statusReport } from "./report";

it("brief status omits completed history but preserves decisions, answers, activity and next actions", () => {
  setLang("en");
  let p = createProject("Demo");
  const ids: string[] = [];
  for (const title of ["Finished history", "Working task", "Pending choice", "Answered choice", "Next task"]) {
    const r = addBlock(p, { title, parentId: defaultTaskParent(p) }); p = r.project; ids.push(r.blockId);
  }
  p = finishBlock(p, ids[0], "codex", {}).project;
  p = setActivity(p, ids[1], "codex", "working", "Implementing");
  p = askDecision(p, ids[2], "codex", "Which color?", ["Blue", "Green"], "Choose the accent").project;
  const ask = askDecision(p, ids[3], "codex", "Which framework?", ["React", "Vue"]);
  p = answerDecision(ask.project, ids[3], ask.decisionId!, "React", "human");
  const before = JSON.stringify(p);
  const brief = statusReport(p, { brief: true });
  expect(brief).not.toContain("Finished history");
  for (const text of ["Working task", "Implementing", "Which color?", "Choose the accent", "Which framework?", "React", "Next task"]) expect(brief).toContain(text);
  expect(statusReport(p)).toContain("Finished history");
  expect(JSON.stringify(p)).toBe(before);
});
