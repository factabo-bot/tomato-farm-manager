"""gas/Code.gs を Apps Script に送り、Web アプリの配備を新しい版に差し替える。

    python tools/deploy.py           # 確認してから送る
    python tools/deploy.py --check   # エディタ上のコードとの照合だけ（送らない）
    python tools/deploy.py --overwrite-editor
        # エディタ上のコードが取り違えなどで明らかに違うと分かっているときだけ使う（照合を飛ばして上書き）

手順:
  1. エディタ上の今のコードを取り寄せ、git の履歴にあるどれかの版と同じか確かめる。
     どれとも違えば、エディタで直接直された部分があるので止める（消さないため）。
  2. 送って、既存の配備を新しい版に差し替える（URLは変わらない）。
  3. 本番に ?action=version を問い合わせ、Code.gs の GAS_VERSION と一致するまで待つ。

設定は .local.json（公開リポジトリに載せない）:
  {"scriptId": "...", "deploymentId": "AKfy..."}
deploymentId が無ければ app/config.js の GAS_URL から読む。
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local.json"
WORK = ROOT / ".deploy"
SRC = ROOT / "gas" / "Code.gs"
CLASP = str(pathlib.Path(os.environ["LOCALAPPDATA"]) / "Programs" / "node" / "clasp.cmd")


def run(args, cwd):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        sys.exit(" ".join(map(str, args)) + " に失敗:\n" + out)
    return out


def norm(s):
    # 改行コードと行末の空白の違いは同じとみなす
    return "\n".join(line.rstrip() for line in s.replace("\r\n", "\n").split("\n")).strip()


def config():
    cfg = json.loads(LOCAL.read_text(encoding="utf-8")) if LOCAL.exists() else {}
    if not cfg.get("scriptId"):
        sys.exit(".local.json に scriptId がありません（Apps Script の「プロジェクトの設定」→スクリプトID）")
    if not cfg.get("deploymentId"):
        m = re.search(r"/macros/s/(AKfy[\w-]+)/exec", (ROOT / "app" / "config.js").read_text(encoding="utf-8"))
        if not m:
            sys.exit("配備IDが分かりません（app/config.js の GAS_URL）")
        cfg["deploymentId"] = m.group(1)
    cfg["url"] = "https://script.google.com/macros/s/%s/exec" % cfg["deploymentId"]
    return cfg


def pull(cfg):
    """エディタ上のコードを .deploy に取り寄せ、コードのファイル名と中身を返す"""
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir()
    (WORK / ".clasp.json").write_text(json.dumps({"scriptId": cfg["scriptId"], "rootDir": "."}), encoding="utf-8")
    run([CLASP, "pull"], WORK)
    codes = [p for p in WORK.iterdir() if p.suffix in (".js", ".gs")]
    if len(codes) != 1:
        sys.exit("コードのファイルが1つではありません: " + ", ".join(p.name for p in codes) + "（想定外なので止めます）")
    return codes[0], codes[0].read_text(encoding="utf-8")


def matches_history(remote):
    """エディタ上のコードが、git に残っている gas/Code.gs のどれかの版と同じか"""
    target = norm(remote)
    shas = run(["git", "rev-list", "HEAD", "--", "gas/Code.gs"], ROOT).split()
    for sha in shas:
        old = subprocess.run(["git", "show", sha + ":gas/Code.gs"], cwd=ROOT, capture_output=True).stdout.decode("utf-8", "replace")
        if norm(old) == target:
            return sha
    return None


def live_version(url):
    try:
        with urllib.request.urlopen(url + "?action=version&nc=" + str(time.time()), timeout=60) as r:
            return json.loads(r.read().decode("utf-8")).get("version")
    except Exception:
        return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    cfg = config()
    code_file, remote = pull(cfg)
    local = SRC.read_text(encoding="utf-8")

    if norm(remote) == norm(local):
        print("エディタ上のコードは手元と同じです（送る必要なし）")
        if "--check" in sys.argv:
            return
    else:
        sha = matches_history(remote)
        if not sha and "--overwrite-editor" in sys.argv:
            (WORK / "editor_version.gs").write_text(remote, encoding="utf-8")
            print("エディタ上のコードはどの版とも違うが、--overwrite-editor 指定なので上書きする（元は .deploy/editor_version.gs に控えた）")
        elif not sha:
            diff_path = WORK / "editor_version.gs"
            diff_path.write_text(remote, encoding="utf-8")
            sys.exit("エディタ上のコードが git のどの版とも違います。エディタで直接直された可能性があるので止めます。\n"
                     "取り寄せたコード: " + str(diff_path))
        else:
            print("エディタ上のコードは git の版 %s と同じ（直接の書き換えなし）" % sha[:7])
        if "--check" in sys.argv:
            return

    m = re.search(r'var GAS_VERSION = "([^"]+)";', local)
    if not m:
        sys.exit("Code.gs に GAS_VERSION がありません")
    version = m.group(1)
    before = live_version(cfg["url"])
    if before == version and norm(remote) != norm(local):
        sys.exit("GAS_VERSION（%s）を上げてください。上げないと反映の確認ができません" % version)

    code_file.write_text(local, encoding="utf-8")
    print(run([CLASP, "push", "--force"], WORK).strip().splitlines()[-1])
    desc = "deploy " + version
    print(run([CLASP, "update-deployment", cfg["deploymentId"], "--description", desc], WORK).strip())

    for _ in range(12):
        v = live_version(cfg["url"])
        if v == version:
            print("本番の版を確認: %s（前は %s）" % (v, before))
            break
        time.sleep(5)
    else:
        sys.exit("デプロイ後も本番の版が %s のままです。手動で確認してください" % live_version(cfg["url"]))

    cfg["lastDeployed"] = version
    LOCAL.write_text(json.dumps({k: cfg[k] for k in ("scriptId", "deploymentId", "lastDeployed")}, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
