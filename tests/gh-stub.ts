// tests/gh-stub.ts — a stand-in for `gh api` shared by the tests of sapu-contract.mjs (issue-trust,
// pr-trust, the scope lock's id check) and sapu-merge.sh. `gh_api` answers from JSON files in $HX_API:
// a REST path as its `/`-separated words joined by `_` (query string dropped); `graphql` as
// graphql_<issue|pr>_<number>[_<after>].json, the kind read from the query itself; `user` as the
// active account ($HX_LOGIN/$HX_UID, default owner/1). `--jq` runs through the real jq, so the filters
// the scripts pass to gh are exercised, not skipped. The fixtures are GitHub's raw shapes: REST
// comments and users, and the GraphQL issue/PR snapshots sapu-contract.mjs queries.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A bash function `gh_api "$@"` for a `gh` stub. */
export const GH_API = `gh_api() {
  local path="" jqf="" num="" after="" q="" kind f
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --jq|-q) jqf="$2"; shift 2 ;;
      -f|-F|--field|--raw-field)
        case "$2" in number=*) num="\${2#number=}" ;; after=*) after="\${2#after=}" ;; query=*) q="\${2#query=}" ;; esac
        shift 2 ;;
      -*) shift ;;
      *) [ -n "$path" ] || path="$1"; shift ;;
    esac
  done
  if [ "$path" = user ]; then
    local u; u="$(printf '{"login":"%s","id":%s}' "\${HX_LOGIN:-owner}" "\${HX_UID:-1}")"
    if [ -n "$jqf" ]; then printf '%s' "$u" | jq -r "$jqf"; else printf '%s\\n' "$u"; fi
    return 0
  fi
  if [ "$path" = graphql ]; then
    case "$q" in *"pullRequest(number"*) kind=pr ;; *) kind=issue ;; esac
    if [ -n "\${HX_GQL_LOG:-}" ] && [ "$kind" = issue ]; then
      case "$q" in *userContentEdits*) echo "full $num \${after:-first}" ;; *) echo "light $num \${after:-first}" ;; esac >> "$HX_GQL_LOG"
    fi
    path="graphql/$kind/$num\${after:+/$after}"
  fi
  path="\${path%%\\?*}"
  f="$HX_API/$(printf '%s' "$path" | tr '/' '_').json"
  [ -f "$f" ] || { echo "gh: Not Found (HTTP 404) $path" >&2; return 1; }
  if [ -n "$jqf" ]; then jq -r "$jqf" "$f"; else cat "$f"; fi
}
`;

/** GitHub's numeric user ids of the logins the tests use. What is compared is the id, never the login. */
export const USERS: Readonly<Record<string, number>> = { owner: 1, alice: 2, bob: 3, "renovate[bot]": 900, stranger: 666, mallory: 667 };
/** A login (its id from USERS), an explicit {login, id} (e.g. a re-registered login), or null (a deleted account). */
export type Who = string | { login: string; id: number } | null;
const idOf = (w: Who) => (w === null ? null : typeof w === "string" ? (USERS[w] ?? 5000) : w.id);
const loginOf = (w: Who) => (w === null ? null : typeof w === "string" ? w : w.login);
/** An actor as the GraphQL queries return it (`login` + `databaseId`), or null. */
export const actor = (w: Who) => (w === null ? null : { login: loginOf(w), databaseId: idOf(w) });

/** A timestamp `minute` minutes into a fixed day, in GitHub's ISO form. */
export const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString().replace(/\.000Z$/, "Z");

/** `labelUpdated` = the minute the label itself was last renamed or edited (default 0: before every event). */
export type IssueEvent = { event: "labeled" | "unlabeled" | "renamed"; actor: Who; minute: number; label?: string; labelUpdated?: number };
export type IssueSpec = {
  author: Who;
  title?: string;
  body?: string;
  /** The labels the issue carries NOW. */
  labels?: string[];
  events?: IssueEvent[];
  /** Split the timeline across this many GraphQL pages (default 1). */
  pages?: number;
  /** Write only the first page: a later page GitHub would fail to return. */
  missingPages?: boolean;
  /** The body's edit history (GraphQL userContentEdits), in any order; `deleted` = a revision its author deleted. */
  edits?: Array<{ by: Who; minute: number; deleted?: boolean }>;
  /** Report more edits than the page holds (totalCount). */
  editsTotal?: number;
  /** lastEditedAt/editor; defaults to the latest of `edits`. */
  edited?: { by: Who; minute: number } | null;
  comments?: Array<{ author: Who; minute: number; body: string }>;
  /** GraphQL answers `issueOrPullRequest: null` without an error. */
  nullNode?: boolean;
  pr?: boolean;
};

const put = (api: string, name: string, v: unknown) => {
  mkdirSync(api, { recursive: true });
  writeFileSync(join(api, `${name}.json`), JSON.stringify(v));
};

/** Writes issue `n` of `repo` ("owner/name") into the fixture dir `api`, as the GraphQL snapshot + REST comments. */
export function writeIssue(api: string, repo: string, n: number, spec: IssueSpec) {
  const events = (spec.events ?? []).map((e) => ({
    __typename: { labeled: "LabeledEvent", unlabeled: "UnlabeledEvent", renamed: "RenamedTitleEvent" }[e.event],
    createdAt: at(e.minute),
    actor: actor(e.actor),
    ...(e.label ? { label: { name: e.label, updatedAt: at(e.labelUpdated ?? 0) } } : {}),
  }));
  const edits = (spec.edits ?? []).map((e) => ({ editedAt: at(e.minute), deletedAt: e.deleted ? at(e.minute + 1) : null, editor: actor(e.by) }));
  const latest = [...(spec.edits ?? [])].sort((a, b) => b.minute - a.minute)[0];
  const edited = spec.edited === undefined ? (latest ?? null) : spec.edited;
  const pages = Math.max(1, spec.pages ?? 1);
  const per = Math.ceil(events.length / pages) || 1;
  for (let p = 0; p < (spec.missingPages ? 1 : pages); p++) {
    const last = p === pages - 1;
    const node = spec.nullNode
      ? null
      : {
          __typename: spec.pr ? "PullRequest" : "Issue",
          title: spec.title ?? `issue ${n}`,
          body: spec.body ?? `body of ${n}`,
          createdAt: at(0),
          lastEditedAt: edited ? at(edited.minute) : null,
          author: actor(spec.author),
          editor: edited ? actor(edited.by) : null,
          labels: { totalCount: (spec.labels ?? []).length, nodes: (spec.labels ?? []).map((name) => ({ name })) },
          userContentEdits: { totalCount: spec.editsTotal ?? edits.length, nodes: edits },
          timelineItems: { pageInfo: { hasNextPage: !last, endCursor: last ? null : `c${p + 1}` }, nodes: events.slice(p * per, (p + 1) * per) },
        };
    put(api, `graphql_issue_${n}${p ? `_c${p}` : ""}`, { data: { repository: { issueOrPullRequest: node } } });
  }
  put(
    api,
    `repos_${repo.replace("/", "_")}_issues_${n}_comments`,
    (spec.comments ?? []).map((c, i) => ({ id: 2000 + i, user: c.author === null ? null : { login: loginOf(c.author), id: idOf(c.author) }, created_at: at(c.minute), body: c.body })),
  );
}

export type Commit = { oid?: string; authors: Array<{ email: string; user: Who }>; authorsTotal?: number; signature?: { isValid: boolean; signer: Who } | null };
export type PrSpec = {
  author: Who;
  state?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  /** nameWithOwner of the head repository; null = deleted. */
  headRepository?: string | null;
  headRefName?: string;
  headRefOid: string;
  baseRefName?: string;
  title?: string;
  body?: string;
  commits: Commit[];
  commitsTotal?: number;
  /** GitHub's closing references; repository null = GitHub did not say which. */
  closing?: Array<{ number: number; repository: string | null }>;
  /** Report `pullRequest: null` without an error. */
  nullNode?: boolean;
};

/** Writes PR `n` of `repo` into `api` as the GraphQL snapshot `pr-trust` reads. */
export function writePr(api: string, repo: string, n: number, spec: PrSpec) {
  const pr = spec.nullNode
    ? null
    : {
        number: n,
        title: spec.title ?? `PR ${n}`,
        body: spec.body ?? "",
        state: spec.state ?? "OPEN",
        isDraft: spec.isDraft ?? false,
        isCrossRepository: spec.isCrossRepository ?? false,
        headRefName: spec.headRefName ?? "feat/x",
        headRefOid: spec.headRefOid,
        baseRefName: spec.baseRefName ?? "main",
        headRepository: spec.headRepository === null ? null : { nameWithOwner: spec.headRepository ?? repo },
        author: actor(spec.author),
        commits: {
          totalCount: spec.commitsTotal ?? spec.commits.length,
          nodes: spec.commits.map((c, i) => ({
            commit: {
              oid: c.oid ?? `${String(i + 1).repeat(7)}${"0".repeat(33)}`,
              authors: { totalCount: c.authorsTotal ?? c.authors.length, nodes: c.authors.map((a) => ({ email: a.email, user: a.user === null ? null : actor(a.user) })) },
              signature: c.signature ? { isValid: c.signature.isValid, signer: actor(c.signature.signer) } : null,
            },
          })),
        },
        closingIssuesReferences: {
          totalCount: (spec.closing ?? []).length,
          nodes: (spec.closing ?? []).map((x) => ({ number: x.number, repository: x.repository === null ? null : { nameWithOwner: x.repository } })),
        },
      };
  put(api, `graphql_pr_${n}`, { data: { repository: { pullRequest: pr } } });
}

/** A REST `repos/<repo>/labels/<name>` answer: label `name` exists in `repo` ("owner/name"). */
export function writeLabel(api: string, repo: string, name: string) {
  put(api, `repos_${repo.replace("/", "_")}_labels_${encodeURIComponent(name)}`, { name });
}

/** A REST `users/<login>` answer: that login now belongs to account `id`. */
export function writeUser(api: string, login: string, id: number) {
  put(api, `users_${login}`, { login, id, type: login.endsWith("[bot]") ? "Bot" : "User" });
}
