/**
 * プロジェクトを開いていないときの画面 (Home)
 * 上から: サンプルを試す / 「自分の計画で始める」の引き出し (ファイルを開く = 見る・コピーして編集・serve で編集して保存 / 新しい計画を作る。
 *         保存済みの計画や前回のファイルがあれば最初から開く) /
 * このブラウザに保存した計画の一覧。
 * 既にあるファイルを開く入口は、AI を使うかどうかに関係なく使うものなので、「ファイルを開く」の 1 か所にまとめる。
 * VS Code の中では、開いているファイルのための案内だけを出す (ブラウザ向けの案内は出さない)。
 */
import { useEffect, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { copyText, pickTextFile } from "../lib/download";
import { canOpenLocalFile, lastLocalFile, pickLocalFile } from "../lib/localfile";
import { getLang, setLang, t, useLang } from "../i18n";

/**
 * Home 画面
 * Input : なし (一覧と操作は store から取る)
 * Output: 画面全体を覆うダイアログの JSX
 */
export function HomeDialog() {
  const lang = useLang(); // 言語が変わったら描き直す (右上の切り替えボタンの表示にも使う)
  const projects = useProjectStore((s) => s.projects);
  const refreshList = useProjectStore((s) => s.refreshList);
  const newProject = useProjectStore((s) => s.newProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const importJSON = useProjectStore((s) => s.importJSON);
  const openSample = useProjectStore((s) => s.openSample);
  const setToast = useProjectStore((s) => s.setToast);
  const openLocalFile = useProjectStore((s) => s.openLocalFile);
  // VS Code の中で、拡張からファイルをまだ受け取れていないときの案内
  const hostNotice = useProjectStore((s) => s.hostNotice);
  // VS Code の中: 開いているファイルの状態 (空・計画として読めない・届かない) と、空のファイルに計画を作る操作、閲覧専用の理由
  const vscodeFile = useProjectStore((s) => s.vscodeFile);
  const createInVsCode = useProjectStore((s) => s.createInVsCode);
  const readonlyReason = useProjectStore((s) => s.readonlyReason);
  const reload = useProjectStore((s) => s.reload);
  // VS Code の拡張の中で動いているか (一覧の計画がファイルとは別のコピーであることを明示するため)
  const inVsCode = typeof window !== "undefined" && !!window.acquireVsCodeApi;
  const [name, setName] = useState("");
  const [last, setLast] = useState<FileSystemFileHandle | null>(null);
  // 「自分の計画で始める」の引き出しを利用者が開閉した結果 (null = まだ触っていない → 下の hasOwn に従う)
  const [ownOpen, setOwnOpen] = useState<boolean | null>(null);
  // このブラウザに保存済みの計画がある、または前回開いたファイルを覚えている (= 初回ではない)
  const hasOwn = projects.length > 0 || !!last;

  // 開いたときに、保存済みの計画の一覧と、前回開いたファイル (Reopen 用) を読む
  useEffect(() => {
    void refreshList();
    void lastLocalFile().then(setLast);
  }, [refreshList]);

  /**
   * 手元のファイル (boxglow.json) を開く
   * Input : existing = 前回開いたファイルのハンドル (Reopen のとき)。省略するとファイル選択を出す
   * Output: なし (開けたら画面が切り替わる。開けなければ理由を通知に出す)
   */
  const openFile = async (existing?: FileSystemFileHandle) => {
    try {
      const h = existing ?? await pickLocalFile();
      if (h) await openLocalFile(h);
    } catch (e) {
      // ブラウザがその場所のファイルを開かせてくれないとき (WSL やネットワーク上の場所など) は、理由と別の開き方を出す
      setToast(t("このファイルはブラウザから直接開けませんでした ({error})。npx boxglow serve --open なら、どの場所のファイルでも開けます", { error: e instanceof Error ? e.name : String(e) }));
    }
  };
  /**
   * JSON ファイルを選んで、ブラウザ内の計画として取り込む (元のファイルとは同期しない)
   * Input : なし (ファイル選択を出す)
   * Output: なし (読めないファイルや形式の誤りは通知に出す。選択を取り消したときは何もしない)
   */
  const doImport = async () => {
    try {
      const text = await pickTextFile(".json,application/json");
      if (text) await importJSON(text);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };
  /** サーバを起動するコマンドをクリップボードへコピーし、結果を通知に出す。Input / Output: なし */
  const copyCommand = async () => setToast(await copyText("npx boxglow serve --open") ? t("コマンドをコピーしました") : t("コピーできませんでした"));

  return (
    <div className="modal-backdrop">
      <div className="card modal home-dialog">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[26px] flex items-center gap-2">
              <span className="tree-glyph white" aria-hidden="true" style={{ width: 32, height: 32, fontSize: 16, lineHeight: "28px", boxShadow: "0 0 12px 3px var(--box-white-glow)" }}>✓</span>
              Boxglow
            </h1>
            <p className="mt-1" style={{ color: "var(--text-muted)" }}>{t("AI エージェントとチームの作業を、ボックスと線で一目で。")}</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === "en" ? "ja" : "en")} aria-label={t("画面の文言の言語を切り替える")}>{lang === "en" ? "日本語" : "English"}</button>
        </div>

        {/* VS Code の中では、開いているファイルのための案内だけを出す。
            ブラウザ向けの案内 (サンプル・ブラウザ内の計画・ファイルを開く・serve) は出さない: VS Code の中の「ブラウザ内」は、
            ファイルとは別の、VS Code の中だけのコピーで、編集しても boxglow.json には保存されないため */}
        {inVsCode ? (
          <section className="home-welcome home-vscode" aria-live="polite">
            {(!vscodeFile || vscodeFile.state === "waiting") && <p>{t("ファイルを読み込んでいます…")}</p>}
            {vscodeFile?.state === "empty" && <>
              <h2>{t("このファイルは、まだ空です")}</h2>
              <p>{t("計画の名前を入力すると、このファイル ({file}) に計画を作ります。", { file: vscodeFile.name })}</p>
              {readonlyReason ? <p className="home-vscode__note" role="alert">{readonlyReason}</p> : (
                <div className="home-create">
                  <label className="sr-only" htmlFor="home-vscode-name">{t("新しい計画の名前")}</label>
                  <input id="home-vscode-name" className="input" autoFocus placeholder={t("新しい計画の名前")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && name.trim()) createInVsCode(name.trim());
                  }} />
                  <button className="btn btn-primary" disabled={!name.trim()} onClick={() => createInVsCode(name.trim())}>Create</button>
                </div>
              )}
            </>}
            {vscodeFile?.state === "invalid" && <>
              <h2>{t("このファイルは、Boxglow の計画として読めません")}</h2>
              <p className="home-vscode__note" role="alert">{vscodeFile.error}</p>
              <p>{t("テキストエディタで開いて、中身を確かめてください (ファイルを右クリック → Open With → Text Editor)。新しく始めるなら、中身を空にしてから開き直すと、名前を付けて計画を作れます。")}</p>
              <button className="btn" onClick={() => void reload()}>{t("もう一度読み込む")}</button>
            </>}
            {vscodeFile?.state === "timeout" && <>
              <h2>{t("VS Code から、ファイルの中身を受け取れていません")}</h2>
              <p>{t("拡張を最新にして、窓を読み込み直してください。WSL の中のファイルは、WSL の窓 (左下に「WSL: ...」と出る窓) で開いてください。")}</p>
              <button className="btn" onClick={() => void reload()}>{t("もう一度読み込む")}</button>
            </>}
          </section>
        ) : <>
        {/* 最初の案内: 初めて来た人向けの見出しと、主な操作「サンプルを試す」1 つだけ (説明の札や流れ図は置かない: 文字を減らす) */}
        {/* VS Code の中: 拡張からファイルが届いていないとき、または一覧のコピーを開こうとしているときに、ファイルとは別物だと明示する */}
        {hostNotice && <p className="save-notice" role="alert">{hostNotice}</p>}
        <section className="home-welcome">
          <h2>{t("AI と進める仕事に、見通しを。")}</h2>
          <p>{t("何ができた？ 何を決めれば進める？ ボックスと線で、次の一歩が見えてきます。")}</p>
          <button className="btn btn-primary" onClick={openSample}>{t("サンプルを試す")}</button>
        </section>
        {/* 自分の計画を開く・作る操作の引き出し。上: 既にあるファイルを開く、下: 新しい計画を作る。
            保存済みの計画や前回のファイルがある人 (2 回目以降) には最初から開いて見せ、何も無い初回だけ閉じておく。
            利用者が自分で開閉したら、その状態を優先する (ownOpen) */}
        <details className="home-disclosure" open={ownOpen ?? hasOwn} onToggle={(e) => { const now = e.currentTarget.open; if (now !== (ownOpen ?? hasOwn)) setOwnOpen(now); }}>
          <summary>{t("自分の計画で始める")}</summary>
        {/* 既にあるファイルを開く: AI を使うかどうかに関係なく、ここから開く (見る / コピーして編集 / 編集してファイルに保存、の 3 通りを 1 か所に並べる) */}
        <section className="home-section home-section--shared" aria-labelledby="home-shared">
          <h2 id="home-shared" className="font-head text-[18px]">{t("ファイルを開く")}</h2>
          <p className="home-description">{t("手元の boxglow.json を開きます。")}</p>
          <div className="flex flex-wrap gap-2">
            {canOpenLocalFile() && <button className="btn btn-primary" onClick={() => void openFile()} title={t("ファイルを開いて、図として見ます (閲覧専用。ファイルが変わると、画面も変わります)")}>{t("開いて見る")}</button>}
            {canOpenLocalFile() && last && <button className="btn" onClick={() => void openFile(last)} title={t("前回開いたファイル")}>Reopen {last.name}</button>}
            <button className="btn" onClick={() => void doImport()} title={t("ファイルの中身を、このブラウザにコピーして編集します (元のファイルは変わりません)")}>{t("コピーして編集")}</button>
          </div>
          <div className="home-server">
            <p className="home-description">{t("編集してファイルに保存するには、計画のあるフォルダーで実行します (AI と一緒に使うときも、これです)。VS Code の拡張でも開けます。")}</p>
            <div className="home-command">
              <code>npx boxglow serve --open</code>
              <button className="btn btn-sm" onClick={() => void copyCommand()}>{t("コピー")}</button>
            </div>
          </div>
        </section>

        <section className="home-section" aria-labelledby="home-browser">
          <h2 id="home-browser" className="font-head text-[18px]">{t("新しい計画を作る")}</h2>
          <p className="home-description">{t("作った計画と、コピーした計画は、このブラウザに保存されます。元のファイルや AI とは、自動では同期しません。")}</p>
          <div className="home-create">
            <label className="sr-only" htmlFor="home-project-name">{t("新しい計画の名前")}</label>
            <input id="home-project-name" className="input" placeholder={t("新しい計画の名前")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && name.trim()) void newProject(name.trim());
            }} />
            <button className="btn" disabled={!name.trim()} onClick={() => void newProject(name.trim())}>Create</button>
          </div>
        </section>

        </details>
        <section aria-labelledby="home-projects">
          <h2 id="home-projects" className="label mb-1">{t("このブラウザに保存した計画")}</h2>
          {inVsCode && <p className="home-description">{t("VS Code の中では、この一覧は VS Code 内のコピーです。開いて編集しても boxglow.json には保存されず、AI にも届きません。")}</p>}
          {projects.length === 0 ? <p className="home-description">{t("保存した計画はここから再開できます。")}</p> : (
            <div className="home-projects">
              {projects.map((m) => <div key={m.id} className="flex items-center gap-2 tree-row">
                <button className="home-project-open" onClick={() => void openProject(m.id)}>
                  <span className="truncate font-head text-[15px]">{m.name}</span>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{new Date(m.updatedAt).toLocaleString(getLang() === "en" ? "en-US" : "ja-JP")}</span>
                </button>
                <button className="btn btn-ghost btn-sm btn-danger flex-none" aria-label={t("「{name}」を削除", { name: m.name })} onClick={() => {
                  if (confirm(t("「{name}」を削除します。よろしいですか?", { name: m.name }))) void deleteProject(m.id);
                }}>×</button>
              </div>)}
            </div>
          )}
        </section>
        </>}
        <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          <a className="underline" href="https://github.com/sukima-log/Boxglow#readme" target="_blank" rel="noopener noreferrer">{t("使い方・CLI の手順")}</a>
          <span aria-hidden="true"> · </span>
          <a className="underline" href="https://www.sukimalog.com/">{t("すきま研究所日誌")}</a>
        </div>
      </div>
    </div>
  );
}
