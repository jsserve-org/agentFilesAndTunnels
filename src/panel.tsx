import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Cable,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  File,
  FolderOpen,
  Globe,
  KeyRound,
  Laptop,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  SquareTerminal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Badge } from "./components/ui/badge";
import { Progress } from "./components/ui/progress";
import { Switch } from "./components/ui/switch";
import { Separator } from "./components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";

type Limits = {
  storage_bytes: number;
  tunnels: number;
};
type Usage = {
  usage: Limits & { agents: number; api_keys: number };
  limits: Limits;
};
type Config = {
  registration_enabled: boolean;
  tcp_public_host: string;
  sites_base_domain: string;
  files_public_host: string;
  tcp_port_start: number;
  tcp_port_end: number;
  max_file_bytes: number;
  retention_hours: number;
};
type Named = {
  id: string;
  label: string;
  created_at?: number;
  email?: string;
  online?: boolean;
};
type Tunnel = {
  id: string;
  kind: "http" | "tcp";
  agent_id: string;
  local_host: string;
  local_port: number;
  url: string | null;
  address: string | null;
  online: boolean;
  email?: string;
};
type StoredFile = {
  id: string;
  name: string;
  size: number;
  url: string;
  expires_at: number;
  email?: string;
};
type Account = {
  id: string;
  email: string;
  admin: boolean;
  created_at: number;
} & Usage;
type Site = {
  id: string;
  name: string;
  size: number;
  visibility: "public" | "login";
  url: string;
  created_at: number;
  email?: string;
};
type Credential = { id: string; token: string };
type Workspace = {
  me: {
    user: { id: string; email: string; avatar_url: string };
    admin: boolean;
  };
  config: Config;
  usage: Usage;
  keys: Named[];
  agents: Named[];
  tunnels: Tunnel[];
  files: StoredFile[];
  sites: Site[];
};
type Resources = {
  sites: Site[];
  tunnels: Tunnel[];
  files: StoredFile[];
  agents: Named[];
  keys: Named[];
};
type Page =
  | "overview"
  | "tunnels"
  | "files"
  | "agents"
  | "keys"
  | "account"
  | "users"
  | "resources"
  | "settings"
  | "sites";
const navigation = [
  { page: "overview", label: "Overview", icon: LayoutDashboard },
  { page: "tunnels", label: "Tunnels", icon: Cable },
  { page: "files", label: "Files", icon: FolderOpen },
  { page: "sites", label: "Sites", icon: Globe },
  { page: "agents", label: "Agents", icon: Laptop },
  { page: "keys", label: "API keys", icon: KeyRound },
  { page: "account", label: "Account", icon: Settings2 },
] as const;
const adminNavigation = [
  { page: "users", label: "Users & limits", icon: Users },
  { page: "resources", label: "Resource moderation", icon: Shield },
  { page: "settings", label: "Settings", icon: Settings2 },
] as const;
const pageDetails: Record<Page, { title: string; description: string }> = {
  sites: {
    title: "Sites",
    description:
      "Host a static website with a lasting URL and optional platform login.",
  },
  overview: {
    title: "Workspace overview",
    description: "Your laptop services and shared files, in one place.",
  },
  tunnels: {
    title: "Tunnels",
    description:
      "Publish a local service with a persistent URL or a public TCP port.",
  },
  files: {
    title: "Files",
    description:
      "Upload once. Share a download link that lasts at least 72 hours.",
  },
  agents: {
    title: "Agents",
    description:
      "Authorize laptops and give your coding agents a way to connect.",
  },
  keys: {
    title: "API keys",
    description: "Credentials for integrations that manage your workspace.",
  },
  account: {
    title: "Account",
    description: "Manage your password and browser sessions.",
  },
  users: {
    title: "Users & limits",
    description: "Create accounts and control each user's resource allowance.",
  },
  resources: {
    title: "Resource moderation",
    description:
      "Inspect resources across accounts and remove abusive activity.",
  },
  settings: {
    title: "Settings",
    description: "Manage registration and public domains.",
  },
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new ApiError(
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : data && typeof data === "object" && "message" in data
          ? String(data.message)
          : "Request failed.",
      response.status,
    );
  return data as T;
}
function post<T>(path: string, body: object) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
function date(n: number) {
  return new Date(n).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function readForm(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
}
function currentPage(): Page {
  const segment = location.pathname.split("/")[2];
  return segment && segment in pageDetails ? (segment as Page) : "overview";
}
function Field({
  label,
  ...props
}: React.ComponentProps<typeof Input> & { label: string }) {
  const id = React.useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: typeof Cable;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center px-4 py-10 text-center sm:px-6">
      <div className="mb-4 rounded-2xl border bg-muted/50 p-4">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-2 w-full max-w-sm break-words text-sm leading-6 text-muted-foreground">
        {children}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
function Status({ online }: { online: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        online
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "bg-muted text-muted-foreground"
      }
    >
      <span
        className={`mr-1.5 size-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400"}`}
      />
      {online ? "Online" : "Offline"}
    </Badge>
  );
}
function UsageMeter({
  label,
  used,
  limit,
  storage = false,
}: {
  label: string;
  used: number;
  limit: number;
  storage?: boolean;
}) {
  const percentage =
    limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / limit) * 100);
  return (
    <div className="space-y-2.5">
      <div className="flex justify-between gap-4 text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {storage ? bytes(used) : used} / {storage ? bytes(limit) : limit}
        </span>
      </div>
      <Progress
        value={percentage}
        aria-label={`${label}: ${used} of ${limit}`}
        className="h-1.5"
      />
    </div>
  );
}
function AppSidebar({
  workspace,
  page,
  navigate,
  logout,
}: {
  workspace: Workspace;
  page: Page;
  navigate: (page: Page) => void;
  logout: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  function go(target: Page) {
    navigate(target);
    if (isMobile) setOpenMobile(false);
  }
  return (
    <Sidebar>
      <SidebarHeader className="px-5 py-6">
        <a
          href="/dashboard"
          onClick={(e) => {
            e.preventDefault();
            go("overview");
          }}
          className="flex items-center gap-3"
        >
          <span className="text-xl font-semibold tracking-tight text-foreground">
            Relay
          </span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton asChild isActive={page === item.page}>
                    <a
                      href={
                        item.page === "overview"
                          ? "/dashboard"
                          : `/dashboard/${item.page}`
                      }
                      onClick={(e) => {
                        e.preventDefault();
                        go(item.page);
                      }}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                      {item.page === "tunnels" &&
                        workspace.tunnels.length > 0 && (
                          <span className="ml-auto text-xs tabular-nums">
                            {workspace.tunnels.length}
                          </span>
                        )}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {workspace.me.admin && (
          <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminNavigation.map((item) => (
                  <SidebarMenuItem key={item.page}>
                    <SidebarMenuButton asChild isActive={page === item.page}>
                      <a
                        href={`/dashboard/${item.page}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go(item.page);
                        }}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-4 p-4">
        <a
          href="/AGENTS.md"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-2 text-xs text-muted-foreground hover:text-primary"
        >
          <BookOpen className="size-4" />
          Agent documentation
          <ArrowUpRight className="ml-auto size-3" />
        </a>
        <Separator />
        <div className="flex items-center gap-2">
          <img
            src={workspace.me.user.avatar_url}
            alt="Your Gravatar"
            referrerPolicy="no-referrer"
            className="size-8 shrink-0 rounded-full border"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {workspace.me.user.email}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {workspace.me.admin ? "Administrator" : "Personal workspace"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Log out"
            onClick={logout}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
function App() {
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);
  const [config, setConfig] = React.useState<Config | null>(null);
  const [signedOut, setSignedOut] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [page, setPage] = React.useState<Page>(currentPage);
  const [notice, setNotice] = React.useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [modal, setModal] = React.useState<
    "agent" | "key" | "tunnel" | "upload" | "user" | "site" | null
  >(null);
  const [credential, setCredential] = React.useState<
    (Credential & { kind: "agent" | "key" }) | null
  >(null);
  const [confirm, setConfirm] = React.useState<{
    title: string;
    description: string;
    run: () => Promise<void>;
  } | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [defaults, setDefaults] = React.useState<Limits>({
    storage_bytes: 1024 ** 3,
    tunnels: 100,
  });
  const [resources, setResources] = React.useState<Resources | null>(null);
  const [resourceTab, setResourceTab] =
    React.useState<keyof Resources>("tunnels");
  const [editing, setEditing] = React.useState<Account | null>(null);
  const [search, setSearch] = React.useState("");
  const [userCode, setUserCode] = React.useState(
    new URLSearchParams(location.search).get("user_code") || "",
  );
  const [verifiedCode, setVerifiedCode] = React.useState<string | null>(null);
  const [siteAccess, setSiteAccess] = React.useState<Site | null>(null);
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");
  const notify = (message: string, error = false) =>
    setNotice({ message, error });
  const refresh = React.useCallback(async () => {
    try {
      const me = await api<Workspace["me"]>("/me");
      const [config, usage, keys, agents, tunnels, files, sites] =
        await Promise.all([
          api<Config>("/config"),
          api<Usage>("/usage"),
          api<Named[]>("/keys"),
          api<Named[]>("/agents"),
          api<Tunnel[]>("/tunnels"),
          api<StoredFile[]>("/files"),
          api<Site[]>("/sites"),
        ]);
      setConfig(config);
      setWorkspace({ me, config, usage, keys, agents, tunnels, files, sites });
      setSignedOut(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setWorkspace(null);
        setSignedOut(true);
        setConfig(await api<Config>("/config"));
      } else throw error;
    }
  }, []);
  const refreshAdmin = React.useCallback(async () => {
    if (!workspace?.me.admin) return;
    if (page === "users") {
      const data = await api<{ users: Account[]; defaults: Limits }>(
        "/admin/users",
      );
      setAccounts(data.users);
      setDefaults(data.defaults);
    }
    if (page === "resources")
      setResources(await api<Resources>("/admin/resources"));
  }, [workspace?.me.admin, page]);
  React.useEffect(() => {
    refresh()
      .catch((error) => notify(error.message, true))
      .finally(() => setLoading(false));
    const interval = setInterval(() => {
      if (!document.hidden)
        refresh().catch((error) => notify(error.message, true));
    }, 15000);
    return () => clearInterval(interval);
  }, [refresh]);
  React.useEffect(() => {
    refreshAdmin().catch((error) => notify(error.message, true));
  }, [refreshAdmin]);
  React.useEffect(() => {
    const siteId = new URLSearchParams(location.search).get("site_login");
    if (workspace && siteId)
      api<Site>(`/sites/${siteId}`)
        .then(setSiteAccess)
        .catch((error) => notify(error.message, true));
  }, [workspace?.me.user.id]);
  React.useEffect(() => {
    const handler = () => {
      setPage(currentPage());
      setUserCode(new URLSearchParams(location.search).get("user_code") || "");
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Request failed.", true);
    } finally {
      setBusy(false);
    }
  }
  function navigate(target: Page) {
    history.pushState(
      null,
      "",
      target === "overview" ? "/dashboard" : `/dashboard/${target}`,
    );
    setPage(target);
    setSearch("");
    setNotice(null);
  }
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    notify("Copied to clipboard.");
  }
  async function remove(path: string, message: string) {
    await api(path, { method: "DELETE" });
    notify(message);
    await refresh();
    await refreshAdmin();
    setConfirm(null);
  }
  function confirmRemoval(path: string, title: string, description: string) {
    setConfirm({
      title,
      description,
      run: () => remove(path, "Resource removed."),
    });
  }
  async function logout() {
    await post("/auth/sign-out", {});
    setCredential(null);
    setModal(null);
    setEditing(null);
    setConfirm(null);
    setAccounts([]);
    setResources(null);
    await refresh();
  }
  const agentPrompt =
    credential?.kind === "agent"
      ? `Connect this laptop to Relay desk at ${location.origin}. Read ${location.origin}/AGENTS.md first. Install the CLI with: curl -fsSL ${location.origin}/install.sh | bash\nFor browser-approved authorization run: ~/.local/bin/relay login --server ${location.origin}\nIf using the manually issued credential instead, set RELAY_SERVER=${location.origin}, RELAY_AGENT=${credential.id}, and RELAY_TOKEN=${credential.token}. Keep relay connect running, publish only the loopback port I request, and return the assigned tunnel address. Use relay list before creating duplicates and relay stop TUNNEL_ID to close a tunnel. Never commit or expose credentials. MCP: ${location.origin}/mcp.`
      : "";
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
        Loading your workspace…
      </div>
    );
  const Notice = notice && (
    <div
      role={notice.error ? "alert" : "status"}
      className={`mb-6 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${notice.error ? "border-red-200 bg-red-50 text-red-800" : "border-blue-200 bg-blue-50 text-blue-900"}`}
    >
      {notice.error ? (
        <CircleHelp className="mt-0.5 size-4 shrink-0" />
      ) : (
        <Check className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words">{notice.message}</span>
      <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
        <X className="size-4" />
      </button>
    </div>
  );
  if (signedOut || !workspace)
    return (
      <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
        <div className="relative hidden flex-col justify-between bg-[#eaf0fc] p-12 lg:flex">
          <div className="flex items-center gap-3 text-lg font-semibold">
            Relay
          </div>
          <div className="max-w-lg">
            <Badge
              variant="outline"
              className="mb-6 border-blue-200 bg-white/60 text-primary"
            >
              Your laptop. A lasting link.
            </Badge>
            <h1 className="text-5xl font-semibold leading-[1.12]">
              Local services,
              <br />
              open to the world.
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-muted-foreground">
              Publish a demo, hand a task to an agent, or share a file. Your
              tunnel address stays assigned when your laptop disconnects.
            </p>
            <div className="mt-10 rounded-xl border border-blue-200 bg-white/70 p-5 font-mono text-sm">
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <SquareTerminal className="size-4" />A connection you approve
              </div>
              <div>relay login</div>
              <div className="mt-2 text-primary">
                ✓ Approved in your browser
              </div>
              <div className="mt-2">relay connect</div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Persistent tunnels · Temporary file sharing · Agent access
          </p>
        </div>
        <main className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm">
            <div className="mb-10 flex items-center gap-2 font-semibold lg:hidden">
              Relay
            </div>
            {Notice}
            <h1 className="text-2xl font-semibold">
              {authMode === "login" ? "Welcome back" : "Create your account"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {userCode
                ? "Log in to review the agent's authorization request."
                : authMode === "login"
                  ? "Log in to manage your tunnels, files, and agents."
                  : "Start your own workspace for services and shared files."}
            </p>
            <form
              className="mt-7 space-y-5"
              onSubmit={(e) => {
                const data = readForm(e);
                void run(async () => {
                  await post(
                    authMode === "login"
                      ? "/auth/sign-in/email"
                      : "/auth/sign-up/email",
                    {
                      ...data,
                      ...(authMode === "register"
                        ? { name: String(data.name) }
                        : {}),
                    },
                  );
                  await refresh();
                  notify("Signed in.");
                });
              }}
            >
              {authMode === "register" && (
                <Field label="Name" name="name" autoComplete="name" required />
              )}
              <Field
                label="Email address"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
                minLength={authMode === "register" ? 12 : undefined}
                maxLength={200}
                required
              />
              <Button disabled={busy} className="w-full">
                {busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
                {authMode === "login" ? "Log in" : "Create account"}
              </Button>
            </form>
            {config?.registration_enabled ? (
              <p className="mt-6 text-center text-sm text-muted-foreground">
                {authMode === "login"
                  ? "New here?"
                  : "Already have an account?"}{" "}
                <button
                  className="font-medium text-primary"
                  onClick={() =>
                    setAuthMode(authMode === "login" ? "register" : "login")
                  }
                >
                  {authMode === "login" ? "Create an account" : "Log in"}
                </button>
              </p>
            ) : (
              <p className="mt-6 text-center text-xs text-muted-foreground">
                Registration is closed. Ask your administrator for an account.
              </p>
            )}
          </div>
        </main>
      </div>
    );
  const restricted =
    ["users", "resources", "settings"].includes(page) && !workspace.me.admin;
  const active = restricted ? "overview" : page;
  const info = pageDetails[active];
  const match = (value: string) =>
    value.toLowerCase().includes(search.toLowerCase());
  const pageAction =
    active === "tunnels" ? (
      <Button onClick={() => setModal("tunnel")}>
        <Plus className="mr-2 size-4" />
        Create tunnel
      </Button>
    ) : active === "sites" ? (
      <Button onClick={() => setModal("site")}>
        <Plus className="mr-2 size-4" />
        Deploy site
      </Button>
    ) : active === "files" ? (
      <Button onClick={() => setModal("upload")}>
        <Plus className="mr-2 size-4" />
        Upload file
      </Button>
    ) : active === "agents" ? (
      <Button onClick={() => setModal("agent")}>
        <Plus className="mr-2 size-4" />
        Create agent
      </Button>
    ) : active === "keys" ? (
      <Button onClick={() => setModal("key")}>
        <Plus className="mr-2 size-4" />
        Create API key
      </Button>
    ) : active === "users" ? (
      <Button onClick={() => setModal("user")}>
        <Plus className="mr-2 size-4" />
        Create user
      </Button>
    ) : null;
  function tunnelTable(tunnels: Tunnel[], admin = false) {
    return tunnels.length ? (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Public address</TableHead>
            {admin && <TableHead>Owner</TableHead>}
            <TableHead>Local target</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tunnels
            .filter((t) =>
              match(`${t.id} ${t.url} ${t.address} ${t.email || ""}`),
            )
            .map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {t.kind.toUpperCase()}
                    </Badge>
                    {t.url ? (
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noreferrer"
                        className="max-w-[260px] truncate font-mono text-xs text-primary hover:underline"
                      >
                        {new URL(t.url).hostname}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{t.address}</span>
                    )}
                  </div>
                  <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    {t.id}
                  </div>
                </TableCell>
                {admin && <TableCell className="text-xs">{t.email}</TableCell>}
                <TableCell className="font-mono text-xs">
                  {t.local_host}:{t.local_port}
                </TableCell>
                <TableCell>
                  <Status online={t.online} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy address for ${t.id}`}
                      onClick={() =>
                        void run(() => copy(t.url || t.address || ""))
                      }
                    >
                      <Copy className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() =>
                        confirmRemoval(
                          `${admin ? "/admin" : ""}/tunnels/${t.id}`,
                          "Stop this tunnel?",
                          "This closes its active connections and releases its public address or TCP port.",
                        )
                      }
                    >
                      Stop
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    ) : (
      <Empty
        icon={Cable}
        title="No tunnels yet"
        action={
          !admin && (
            <Button onClick={() => setModal("tunnel")}>
              <Plus className="mr-2 size-4" />
              Create your first tunnel
            </Button>
          )
        }
      >
        Connect an agent, then publish a loopback port. Its address stays
        assigned while the laptop is offline.
      </Empty>
    );
  }
  function fileTable(files: StoredFile[], admin = false) {
    return files.length ? (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            {admin && <TableHead>Owner</TableHead>}
            <TableHead>Size</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files
            .filter((f) => match(`${f.name} ${f.email || ""}`))
            .map((f) => (
              <TableRow key={f.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <File className="size-4 text-muted-foreground" />
                    <span className="max-w-[240px] truncate font-medium">
                      {f.name}
                    </span>
                  </div>
                </TableCell>
                {admin && <TableCell className="text-xs">{f.email}</TableCell>}
                <TableCell className="font-mono text-xs">
                  {bytes(f.size)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {date(f.expires_at)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy link for ${f.name}`}
                      onClick={() => void run(() => copy(f.url))}
                    >
                      <Copy className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <a href={f.url} aria-label={`Download ${f.name}`}>
                        <ArrowDownToLine className="size-4" />
                      </a>
                    </Button>
                    {
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={`Delete ${f.name}`}
                        onClick={() =>
                          confirmRemoval(
                            `${admin ? "/admin" : ""}/files/${f.id}`,
                            "Delete this file?",
                            "The file and its download link will be permanently removed.",
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    }
                  </div>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    ) : (
      <Empty
        icon={FolderOpen}
        title="No shared files"
        action={
          !admin && (
            <Button onClick={() => setModal("upload")}>Upload a file</Button>
          )
        }
      >
        A file upload creates a link anyone can use until it expires. Share
        links only with your intended recipients.
      </Empty>
    );
  }
  function siteTable(sites: Site[], admin = false) {
    return sites.length ? (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Site</TableHead>
            {admin && <TableHead>Owner</TableHead>}
            <TableHead>Access</TableHead>
            <TableHead>Size</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sites
            .filter((site) => match(`${site.name} ${site.email ?? ""}`))
            .map((site) => (
              <TableRow key={site.id}>
                <TableCell>
                  <div className="font-medium">{site.name}</div>
                  <a
                    href={site.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block max-w-[250px] truncate font-mono text-[11px] text-primary"
                  >
                    {new URL(site.url).hostname}
                  </a>
                </TableCell>
                {admin && <TableCell>{site.email}</TableCell>}
                <TableCell>
                  <Badge variant="outline">
                    {site.visibility === "login" ? "Login required" : "Public"}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {bytes(site.size)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy URL for ${site.name}`}
                      onClick={() => void run(() => copy(site.url))}
                    >
                      <Copy className="size-4" />
                    </Button>
                    {!admin && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`/sites/${site.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                visibility:
                                  site.visibility === "login"
                                    ? "public"
                                    : "login",
                              }),
                            });
                            await refresh();
                            notify("Site access updated.");
                          })
                        }
                      >
                        {site.visibility === "login"
                          ? "Make public"
                          : "Require login"}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete site ${site.name}`}
                      className="text-destructive"
                      onClick={() =>
                        confirmRemoval(
                          `${admin ? "/admin" : ""}/sites/${site.id}`,
                          "Delete this site?",
                          "All site files and the hosted URL will be removed.",
                        )
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    ) : (
      <Empty
        icon={Globe}
        title="No sites deployed"
        action={
          !admin && (
            <Button onClick={() => setModal("site")}>
              Deploy your first site
            </Button>
          )
        }
      >
        Upload a ZIP with index.html at its root. Choose whether visitors need a
        platform account to view it.
      </Empty>
    );
  }
  function limitFields(limits: Limits) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Storage (MB)"
          name="storage_mb"
          type="number"
          min={0}
          step="any"
          defaultValue={limits.storage_bytes / 1024 ** 2}
          required
        />
        <Field
          label="Reserved tunnels"
          name="tunnels"
          type="number"
          min={0}
          step={1}
          defaultValue={limits.tunnels}
          required
        />
      </div>
    );
  }
  function readLimits(data: Record<string, FormDataEntryValue>): Limits {
    return {
      storage_bytes: Math.round(Number(data.storage_mb) * 1024 ** 2),
      tunnels: Number(data.tunnels),
    };
  }
  return (
    <SidebarProvider>
      <AppSidebar
        workspace={workspace}
        page={active}
        navigate={navigate}
        logout={() => void run(logout)}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b bg-white px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
              {["users", "resources", "settings"].includes(active)
                ? "Administration"
                : "Workspace"}
            </span>
            <ChevronRight className="size-3 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{info.title}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className="hidden font-normal sm:inline-flex"
            >
              <span className="mr-1.5 size-1.5 rounded-full bg-primary" />
              {workspace.tunnels.filter((t) => t.online).length} online
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="Refresh workspace"
              onClick={() =>
                void run(async () => {
                  await refresh();
                  await refreshAdmin();
                  notify("Workspace refreshed.");
                })
              }
            >
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] p-4 md:p-8 lg:p-10">
          <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold md:text-3xl">
                {info.title}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {info.description}
              </p>
            </div>
            {pageAction}
          </div>
          {Notice}
          {siteAccess && (
            <Card className="mb-6 border-blue-200 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">
                  Continue to {siteAccess.name}
                </CardTitle>
                <CardDescription>
                  Use your Relay account to open this site. It can read your
                  name and email while you are signed in.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="mb-4 break-all font-mono text-xs text-muted-foreground">
                  {siteAccess.url}
                </p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const redirect = await post<{ url: string }>(
                        `/sites/${siteAccess.id}/login`,
                        {
                          return_path:
                            new URLSearchParams(location.search).get(
                              "return_path",
                            ) || "/",
                        },
                      );
                      location.assign(redirect.url);
                    })
                  }
                >
                  Continue to site
                  <ArrowUpRight className="ml-2 size-4" />
                </Button>
              </CardContent>
            </Card>
          )}
          {active === "overview" && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: "Reserved tunnels",
                    value: workspace.tunnels.length,
                    detail: `${workspace.tunnels.filter((t) => t.online).length} reachable now`,
                    icon: Cable,
                    target: "tunnels" as Page,
                  },
                  {
                    label: "Stored files",
                    value: workspace.files.length,
                    detail:
                      bytes(workspace.usage.usage.storage_bytes) +
                      " in storage",
                    icon: FolderOpen,
                    target: "files" as Page,
                  },
                  {
                    label: "Registered agents",
                    value: workspace.agents.length,
                    detail: "Browser approval or connection token",
                    icon: Laptop,
                    target: "agents" as Page,
                  },
                  {
                    label: "API keys",
                    value: workspace.keys.length,
                    detail: "For your apps and integrations",
                    icon: KeyRound,
                    target: "keys" as Page,
                  },
                ].map((metric) => (
                  <Card key={metric.label} className="shadow-none">
                    <CardContent className="p-5">
                      <div className="mb-5 flex items-center justify-between text-sm text-muted-foreground">
                        <span>{metric.label}</span>
                        <metric.icon className="size-4" />
                      </div>
                      <div className="text-3xl font-semibold tabular-nums">
                        {metric.value}
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          {metric.detail}
                        </p>
                        <button
                          aria-label={`View ${metric.label.toLowerCase()}`}
                          onClick={() => navigate(metric.target)}
                        >
                          <ArrowUpRight className="size-4 text-primary" />
                        </button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0 space-y-6">
                  <Card className="overflow-hidden border-blue-200 bg-[#eef3fe] shadow-none">
                    <CardContent className="p-6">
                      <div className="flex items-start gap-4">
                        <div className="rounded-xl border border-blue-200 bg-white p-3">
                          <SquareTerminal className="size-5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold">
                            Make your laptop reachable
                          </h2>
                          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                            Install the CLI, approve an agent in your browser,
                            then connect it to publish a service. No public
                            laptop IP required.
                          </p>
                          <div className="mt-4 overflow-x-auto rounded-md border border-blue-200 bg-white px-3 py-2 font-mono text-xs whitespace-nowrap">
                            curl -fsSL {location.origin}/install.sh | bash
                          </div>
                          <div className="mt-5 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => navigate("agents")}
                            >
                              Set up an agent
                              <ArrowUpRight className="ml-2 size-4" />
                            </Button>
                            <Button variant="outline" size="sm" asChild>
                              <a
                                href="/AGENTS.md"
                                target="_blank"
                                rel="noreferrer"
                              >
                                Read AGENTS.md
                              </a>
                            </Button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="shadow-none">
                    <CardHeader className="flex flex-row items-center justify-between">
                      <div>
                        <CardTitle className="text-base">
                          Your tunnels
                        </CardTitle>
                        <CardDescription>
                          Addresses stay reserved while you're offline.
                        </CardDescription>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate("tunnels")}
                      >
                        View all
                        <ChevronRight className="ml-1 size-4" />
                      </Button>
                    </CardHeader>
                    <CardContent className="p-0">
                      {tunnelTable(workspace.tunnels.slice(0, 5))}
                    </CardContent>
                  </Card>
                </div>
                <Card className="min-w-0 h-fit shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Your allowance</CardTitle>
                    <CardDescription>
                      Limits set by your administrator.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <UsageMeter
                      label="File storage"
                      used={workspace.usage.usage.storage_bytes}
                      limit={workspace.usage.limits.storage_bytes}
                      storage
                    />
                    <UsageMeter
                      label="Reserved tunnels"
                      used={workspace.usage.usage.tunnels}
                      limit={workspace.usage.limits.tunnels}
                    />
                    <Separator />
                    <p className="text-xs leading-5 text-muted-foreground">
                      Offline tunnels still use a reservation. Stop unused
                      tunnels to free your allowance.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
          {active === "tunnels" && (
            <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <Input
                  className="max-w-xs bg-white"
                  placeholder="Search addresses…"
                  aria-label="Search tunnels"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  {workspace.usage.usage.tunnels} /{" "}
                  {workspace.usage.limits.tunnels} reservations
                </span>
              </div>
              <Card className="shadow-none">
                <CardContent className="p-0">
                  {tunnelTable(workspace.tunnels)}
                </CardContent>
              </Card>
              <p className="mt-4 text-xs text-muted-foreground">
                HTTP URLs work through your wildcard domain. TCP addresses
                forward raw traffic, including local HTTPS.
              </p>
            </>
          )}
          {active === "files" && (
            <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <Input
                  className="max-w-xs bg-white"
                  placeholder="Search files…"
                  aria-label="Search files"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  {bytes(workspace.usage.usage.storage_bytes)} /{" "}
                  {bytes(workspace.usage.limits.storage_bytes)}
                </span>
              </div>
              <Card className="shadow-none">
                <CardContent className="p-0">
                  {fileTable(workspace.files)}
                </CardContent>
              </Card>
              <p className="mt-4 text-xs text-muted-foreground">
                Maximum file size: {bytes(workspace.config.max_file_bytes)}.
                Retention: {workspace.config.retention_hours} hours. Anyone with
                a download link can access its file.
              </p>
            </>
          )}
          {active === "sites" && (
            <div className="space-y-5">
              <Card className="shadow-none">
                <CardContent className="p-0">
                  {siteTable(workspace.sites)}
                </CardContent>
              </Card>
              <div className="grid gap-5 md:grid-cols-2">
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">
                      Persistent static hosting
                    </CardTitle>
                    <CardDescription>
                      ZIP uploads are kept until you delete the site.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Put index.html at the archive root and use relative paths
                      for assets. Extracted site files count toward your storage
                      allowance. Maximum: 100 MB and 2,000 entries per site.
                    </p>
                  </CardContent>
                </Card>
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">
                      Built-in platform login
                    </CardTitle>
                    <CardDescription>
                      Authentication uses the same Better Auth instance.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Login-protected sites require a Relay account before
                      visitors can read any file. Your static JavaScript can
                      fetch <code className="text-xs">/__relay/me</code> for the
                      visitor's name, email, and login URL.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
          {active === "agents" && (
            <div className="space-y-6">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    Connect with browser approval
                  </CardTitle>
                  <CardDescription>
                    Run these commands on the laptop or remote agent, then
                    approve the displayed code here.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-7">
                      curl -fsSL {location.origin}/install.sh | bash{"\n"}
                      ~/.local/bin/relay login --server {location.origin}
                      {"\n"}~/.local/bin/relay connect
                    </pre>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void run(() =>
                          copy(
                            `curl -fsSL ${location.origin}/install.sh | bash\n~/.local/bin/relay login --server ${location.origin}\n~/.local/bin/relay connect`,
                          ),
                        )
                      }
                    >
                      <Copy className="mr-2 size-4" />
                      Copy commands
                    </Button>
                  </div>
                  <form
                    className="mt-5 flex flex-wrap items-end gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const data = await api<{
                          status: string;
                          client_id?: string;
                        }>(
                          `/auth/device?user_code=${encodeURIComponent(userCode)}`,
                        );
                        if (
                          data.status !== "pending" ||
                          data.client_id !== "relay-cli"
                        )
                          throw Error(
                            "This request is expired, processed, or unavailable. Ask the agent to run login again.",
                          );
                        setVerifiedCode(userCode);
                      });
                    }}
                  >
                    <div className="w-56">
                      <Field
                        label="Agent approval code"
                        value={userCode}
                        onChange={(e) => {
                          setUserCode(e.target.value.toUpperCase());
                          setVerifiedCode(null);
                        }}
                        placeholder="XXXX-XXXX"
                        required
                      />
                    </div>
                    <Button variant="outline" disabled={busy}>
                      Review request
                    </Button>
                  </form>
                  {verifiedCode && (
                    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
                      <h3 className="text-sm font-semibold">
                        Authorize this agent?
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Approve only if the code{" "}
                        <strong className="font-mono text-foreground">
                          {verifiedCode}
                        </strong>{" "}
                        matches the one on your agent. It can manage its own
                        tunnels and upload files using your allowance.
                      </p>
                      <div className="mt-4 flex gap-2">
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await post("/auth/device/approve", {
                                userCode: verifiedCode,
                              });
                              setVerifiedCode(null);
                              setUserCode("");
                              notify(
                                "Agent approved. The CLI will finish connecting.",
                              );
                            })
                          }
                        >
                          Approve agent
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await post("/auth/device/deny", {
                                userCode: verifiedCode,
                              });
                              setVerifiedCode(null);
                              notify("Authorization denied.");
                            })
                          }
                        >
                          Deny
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="mt-5 flex items-center gap-2 text-sm">
                    <BookOpen className="size-4 text-muted-foreground" />
                    <a
                      href="/AGENTS.md"
                      download
                      className="text-primary hover:underline"
                    >
                      Download AGENTS.md
                    </a>
                    <span className="text-xs text-muted-foreground">
                      Setup, CLI commands, and MCP access
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Registered agents</CardTitle>
                  <CardDescription>
                    {workspace.agents.length} registered agents. Manual
                    credentials are shown once.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {workspace.agents.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Agent</TableHead>
                          <TableHead>Connection</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {workspace.agents.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell>
                              <div className="font-medium">{a.label}</div>
                              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                {a.id}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Status online={Boolean(a.online)} />
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setConfirm({
                                    title: "Replace this agent's credential?",
                                    description:
                                      "This revokes its current token or device authorization. Reconnect using the new token.",
                                    run: async () => {
                                      const token = await post<Credential>(
                                        `/agents/${a.id}/rotate`,
                                        {},
                                      );
                                      setCredential({
                                        ...token,
                                        kind: "agent",
                                      });
                                      setConfirm(null);
                                      await refresh();
                                    },
                                  })
                                }
                              >
                                Replace token
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-2 text-destructive"
                                onClick={() =>
                                  confirmRemoval(
                                    `/agents/${a.id}`,
                                    "Revoke this agent?",
                                    "This revokes its credential and stops all its tunnels.",
                                  )
                                }
                              >
                                Revoke
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Empty icon={Laptop} title="No agents connected yet">
                      Use browser approval above, or create an agent manually to
                      get an ID and token.
                    </Empty>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
          {active === "keys" && (
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Workspace API keys</CardTitle>
                <CardDescription>
                  {workspace.keys.length} API keys. Secrets appear only when
                  created.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {workspace.keys.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspace.keys.map((k) => (
                        <TableRow key={k.id}>
                          <TableCell>
                            <div className="font-medium">{k.label}</div>
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                              {k.id}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {k.created_at ? date(k.created_at) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() =>
                                confirmRemoval(
                                  `/keys/${k.id}`,
                                  "Revoke this API key?",
                                  "Integrations using this key will lose access immediately.",
                                )
                              }
                            >
                              Revoke key
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Empty
                    icon={KeyRound}
                    title="No API keys yet"
                    action={
                      <Button onClick={() => setModal("key")}>
                        Create an API key
                      </Button>
                    }
                  >
                    Use a key for your integrations. For laptop agents, prefer
                    browser approval on the Agents page.
                  </Empty>
                )}
              </CardContent>
            </Card>
          )}
          {active === "account" && (
            <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Change password</CardTitle>
                  <CardDescription>{workspace.me.user.email}</CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="space-y-5"
                    onSubmit={(e) => {
                      const form = e.currentTarget;
                      const data = readForm(e);
                      void run(async () => {
                        await post("/auth/change-password", {
                          ...data,
                          revokeOtherSessions: true,
                        });
                        form.reset();
                        notify(
                          "Password changed. Other browsers have been signed out.",
                        );
                      });
                    }}
                  >
                    <Field
                      label="Current password"
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                    <Field
                      label="New password"
                      name="newPassword"
                      type="password"
                      minLength={12}
                      maxLength={200}
                      autoComplete="new-password"
                      required
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      Use at least 12 characters. Changing your password signs
                      out your other browser sessions.
                    </p>
                    <Button disabled={busy}>Change password</Button>
                  </form>
                </CardContent>
              </Card>
              <Card className="h-fit shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Browser sessions</CardTitle>
                  <CardDescription>
                    End sessions on other devices.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="mb-5 text-sm leading-6 text-muted-foreground">
                    API keys remain active. Agents using device authorization
                    will need to log in again if their session is revoked.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await post("/auth/revoke-other-sessions", {});
                        notify("Other sessions signed out.");
                      })
                    }
                  >
                    Sign out other sessions
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
          {active === "users" && (
            <>
              <div className="mb-5">
                <Input
                  className="max-w-xs bg-white"
                  placeholder="Search users by email…"
                  aria-label="Search users"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Card className="shadow-none">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Storage</TableHead>
                        <TableHead>Tunnels</TableHead>
                        <TableHead>Agents / keys</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {accounts
                        .filter((u) => match(u.email))
                        .map((u) => (
                          <TableRow key={u.id}>
                            <TableCell>
                              <div className="flex items-center gap-2 font-medium">
                                {u.email}
                                {u.admin && (
                                  <Badge variant="secondary">Admin</Badge>
                                )}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Created {date(u.created_at)}
                              </p>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {bytes(u.usage.storage_bytes)} /{" "}
                              {bytes(u.limits.storage_bytes)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {u.usage.tunnels} / {u.limits.tunnels}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div>{u.usage.agents} agents</div>
                              <div className="mt-1 text-muted-foreground">
                                {u.usage.api_keys} keys
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditing(u)}
                              >
                                Edit limits
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Set any limit to 0 to block new resources of that type. Lowering
                a limit preserves existing resources; remove abusive resources
                from Resource moderation.
              </p>
            </>
          )}
          {active === "resources" && (
            <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1 rounded-lg border bg-white p-1">
                  {(
                    ["tunnels", "files", "sites", "agents", "keys"] as const
                  ).map((tab) => (
                    <Button
                      key={tab}
                      variant={resourceTab === tab ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => {
                        setResourceTab(tab);
                        setSearch("");
                      }}
                    >
                      {tab === "keys"
                        ? "API keys"
                        : tab.charAt(0).toUpperCase() + tab.slice(1)}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {resources?.[tab].length ?? 0}
                      </span>
                    </Button>
                  ))}
                </div>
                <Input
                  className="max-w-xs bg-white"
                  placeholder="Search resources or owners…"
                  aria-label="Search resources"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Card className="shadow-none">
                <CardContent className="p-0">
                  {!resources ? (
                    <div className="p-8 text-sm text-muted-foreground">
                      Loading resources…
                    </div>
                  ) : resourceTab === "tunnels" ? (
                    tunnelTable(resources.tunnels, true)
                  ) : resourceTab === "files" ? (
                    fileTable(resources.files, true)
                  ) : resourceTab === "sites" ? (
                    siteTable(resources.sites, true)
                  ) : resources[resourceTab].length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Owner</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {resources[resourceTab]
                          .filter((r) => match(`${r.label} ${r.email}`))
                          .map((r) => (
                            <TableRow key={r.id}>
                              <TableCell>
                                <div className="font-medium">{r.label}</div>
                                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                  {r.id}
                                </div>
                              </TableCell>
                              <TableCell>{r.email}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive"
                                  onClick={() =>
                                    confirmRemoval(
                                      `/admin/${resourceTab}/${r.id}`,
                                      `Revoke this ${resourceTab === "agents" ? "agent" : "API key"}?`,
                                      resourceTab === "agents"
                                        ? "This disconnects the agent, revokes its credential, and stops all its tunnels."
                                        : "Any integration using this key will lose access immediately.",
                                    )
                                  }
                                >
                                  Revoke
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Empty icon={Shield} title="No resources to review">
                      Resources will appear here when users create them.
                    </Empty>
                  )}
                </CardContent>
              </Card>
            </>
          )}
          {active === "settings" && (
            <Card className="max-w-2xl shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Public registration</CardTitle>
                <CardDescription>
                  Administrators can create users even when registration is
                  closed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-start justify-between gap-6 rounded-lg border p-5">
                  <div>
                    <Label htmlFor="registration">
                      Allow visitors to create accounts
                    </Label>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {workspace.config.registration_enabled
                        ? "Registration is open. New accounts receive the default allowance."
                        : "Registration is closed. Existing users can still log in."}
                    </p>
                  </div>
                  <Switch
                    id="registration"
                    checked={workspace.config.registration_enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      void run(async () => {
                        await api("/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            registration_enabled: enabled,
                          }),
                        });
                        await refresh();
                        notify(
                          enabled
                            ? "Registration opened."
                            : "Registration closed.",
                        );
                      })
                    }
                  />
                </div>
              </CardContent>
              <Separator />
              <CardHeader>
                <CardTitle className="text-base">Content domains</CardTitle>
                <CardDescription>
                  Keep hosted websites and file downloads on separate domains
                  from the panel.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  key={
                    workspace.config.sites_base_domain +
                    workspace.config.files_public_host
                  }
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    void run(async () => {
                      await api("/admin/settings", {
                        method: "PATCH",
                        body: JSON.stringify({
                          sites_base_domain: fields.get("sites_base_domain"),
                          files_public_host: fields.get("files_public_host"),
                        }),
                      });
                      await refresh();
                      notify("Content domains updated.");
                    });
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="sites-domain">Website base domain</Label>
                    <Input
                      id="sites-domain"
                      name="sites_base_domain"
                      defaultValue={workspace.config.sites_base_domain}
                      placeholder="ugsites.2oo.dev"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="files-host">File download hostname</Label>
                    <Input
                      id="files-host"
                      name="files_public_host"
                      defaultValue={workspace.config.files_public_host}
                      placeholder="ugfiles.2oo.dev"
                      required
                    />
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Configure wildcard DNS and an HTTPS proxy for your website
                    domain, and a separate HTTPS proxy for your file hostname,
                    pointing to this server. Enter hostnames without https:// or
                    *. Changing domains updates published links immediately;
                    website visitors will need to log in on the new domain.
                  </p>
                  <Button disabled={busy} type="submit">
                    Save content domains
                  </Button>
                </form>
              </CardContent>
              <Separator />
              <CardHeader>
                <CardTitle className="text-base">
                  Direct TCP forwarding
                </CardTitle>
                <CardDescription>
                  Use a separate DNS hostname for raw TCP connections. Changes
                  apply to all tunnel addresses immediately; reserved ports stay
                  the same.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  key={workspace.config.tcp_public_host}
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    void run(async () => {
                      await api("/admin/settings", {
                        method: "PATCH",
                        body: JSON.stringify({
                          tcp_public_host: fields.get("tcp_public_host"),
                        }),
                      });
                      await refresh();
                      notify("TCP hostname updated.");
                    });
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="tcp-public-host">Public TCP hostname</Label>
                    <Input
                      id="tcp-public-host"
                      name="tcp_public_host"
                      defaultValue={workspace.config.tcp_public_host}
                      placeholder="direct-tunnel.2oo.dev"
                      required
                    />
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Point this hostname to the selected WAN address and forward
                    TCP ports {workspace.config.tcp_port_start}–
                    {workspace.config.tcp_port_end} on OpenWrt directly to this
                    server. DNS and router rules are configured separately.
                    Changing the listener range requires updating the server
                    configuration and restarting it.
                  </p>
                  <Button disabled={busy} type="submit">
                    Save TCP hostname
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </main>
      </SidebarInset>
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {modal === "agent"
                ? "Create agent"
                : modal === "key"
                  ? "Create API key"
                  : modal === "tunnel"
                    ? "Create tunnel"
                    : modal === "user"
                      ? "Create user"
                      : modal === "site"
                        ? "Deploy static site"
                        : "Upload file"}
            </DialogTitle>
            <DialogDescription>
              {modal === "agent"
                ? "Manual credentials are shown once. Browser approval is also available on the Agents page."
                : modal === "key"
                  ? "Save the secret before closing. It won't be shown again."
                  : modal === "tunnel"
                    ? "Choose an agent and the local port it should expose."
                    : modal === "user"
                      ? "Better Auth creates the account. Give the initial password to the user privately."
                      : modal === "site"
                        ? "Upload a ZIP containing index.html at its root. Site files share your account's storage allowance."
                        : `Files are kept for ${workspace.config.retention_hours} hours, with a maximum size of ${bytes(workspace.config.max_file_bytes)}.`}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              const form = e.currentTarget;
              const data = readForm(e);
              void run(async () => {
                if (modal === "agent" || modal === "key") {
                  const kind = modal;
                  const result = await post<Credential>(
                    kind === "agent" ? "/agents" : "/keys",
                    data,
                  );
                  setCredential({ ...result, kind });
                }
                if (modal === "tunnel") {
                  await post("/tunnels", {
                    agent_id: data.agent_id,
                    kind: data.kind,
                    local_port: Number(data.local_port),
                    local_host: "127.0.0.1",
                  });
                  notify(
                    "Tunnel created. Connect its agent to make the service reachable.",
                  );
                }
                if (modal === "upload") {
                  await api("/files", {
                    method: "POST",
                    body: new FormData(form),
                  });
                  notify(
                    "File uploaded. Copy its download link from the Files page.",
                  );
                }
                if (modal === "site") {
                  await api("/sites", {
                    method: "POST",
                    body: new FormData(form),
                  });
                  notify(
                    "Site deployed. Its URL will stay online until you delete it.",
                  );
                }
                if (modal === "user") {
                  await post("/admin/users", {
                    name: data.name,
                    email: data.email,
                    password: data.password,
                    limits: readLimits(data),
                  });
                  notify(
                    "User created. They can now log in with their initial password.",
                  );
                  await refreshAdmin();
                }
                setModal(null);
                await refresh();
              });
            }}
          >
            {(modal === "agent" || modal === "key") && (
              <Field
                label={modal === "agent" ? "Agent name" : "Key name"}
                name="label"
                placeholder={
                  modal === "agent" ? "My laptop" : "Demo integration"
                }
                maxLength={100}
                required
                autoFocus
              />
            )}
            {modal === "tunnel" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="tunnel-agent">Agent</Label>
                  <select
                    id="tunnel-agent"
                    name="agent_id"
                    className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                    required
                  >
                    <option value="">Choose an agent</option>
                    {workspace.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                {!workspace.agents.length && (
                  <p className="text-sm text-muted-foreground">
                    Create an agent on the Agents page first.
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="tunnel-kind">Protocol</Label>
                  <select
                    id="tunnel-kind"
                    name="kind"
                    className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  >
                    <option value="http">HTTP — wildcard URL</option>
                    <option value="tcp">
                      TCP — public port (including HTTPS)
                    </option>
                  </select>
                </div>
                <Field
                  label="Local port"
                  name="local_port"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="3000"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  The target is 127.0.0.1 on the agent's machine.
                </p>
              </>
            )}
            {modal === "upload" && (
              <Field label="Choose a file" name="file" type="file" required />
            )}
            {modal === "site" && (
              <>
                <Field label="Site name" name="name" maxLength={100} required />
                <Field
                  label="Website ZIP"
                  name="file"
                  type="file"
                  accept=".zip,application/zip"
                  required
                />
                <div className="space-y-2">
                  <Label htmlFor="site-visibility">Visitor access</Label>
                  <select
                    id="site-visibility"
                    name="visibility"
                    defaultValue="login"
                    className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  >
                    <option value="login">Require a platform login</option>
                    <option value="public">Public — anyone can visit</option>
                  </select>
                </div>
              </>
            )}
            {modal === "user" && (
              <>
                <Field label="Name" name="name" maxLength={100} required />
                <Field label="Email" name="email" type="email" required />
                <Field
                  label="Initial password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={200}
                  required
                />
                <Separator />
                <div>
                  <h3 className="mb-4 text-sm font-semibold">
                    Resource allowance
                  </h3>
                  {limitFields(defaults)}
                </div>
              </>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  busy || (modal === "tunnel" && !workspace.agents.length)
                }
              >
                {busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
                {modal === "upload"
                  ? "Upload file"
                  : modal === "site"
                    ? "Deploy site"
                    : modal === "user"
                      ? "Create user"
                      : modal === "tunnel"
                        ? "Create tunnel"
                        : modal === "agent"
                          ? "Create agent"
                          : "Create API key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!credential}
        onOpenChange={(open) => {
          if (!open) setCredential(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {credential?.kind === "agent" ? "Agent ready" : "API key created"}
            </DialogTitle>
            <DialogDescription>
              Save this credential now. The secret is shown only once.
            </DialogDescription>
          </DialogHeader>
          {credential && (
            <>
              <pre className="max-h-48 overflow-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-6 break-all whitespace-pre-wrap">
                {credential.kind === "agent"
                  ? `Agent ID: ${credential.id}\nToken: ${credential.token}`
                  : credential.token}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void run(() => copy(credential.token))}
                >
                  <Copy className="mr-2 size-4" />
                  Copy token
                </Button>
                {credential.kind === "agent" && (
                  <Button onClick={() => void run(() => copy(agentPrompt))}>
                    <SquareTerminal className="mr-2 size-4" />
                    Copy agent prompt
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                The agent prompt contains this secret. Share it only with your
                trusted agent.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit user limits</DialogTitle>
            <DialogDescription>
              {editing?.email}. Existing resources are kept when a limit is
              lowered.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                const data = readForm(e);
                void run(async () => {
                  await api(`/admin/users/${editing.id}/limits`, {
                    method: "PATCH",
                    body: JSON.stringify(readLimits(data)),
                  });
                  setEditing(null);
                  await refreshAdmin();
                  await refresh();
                  notify("Usage limits saved.");
                });
              }}
            >
              {limitFields(editing.limits)}
              <p className="text-xs text-muted-foreground">
                Zero blocks new resources. Limits apply to the panel, CLI, API,
                and MCP.
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditing(null)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button disabled={busy}>Save limits</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (confirm) await confirm.run();
                })
              }
            >
              {busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
