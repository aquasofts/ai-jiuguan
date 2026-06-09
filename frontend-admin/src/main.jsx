import React from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { BarChart3, Bot, CreditCard, DatabaseZap, Edit3, History, KeyRound, LayoutDashboard, LogOut, Plus, Save, Search, SlidersHorizontal, Trash2, Users } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:2255" : "");
const routes = [
  { path: "/admin/dashboard", label: "首页", icon: LayoutDashboard },
  { path: "/admin/users", label: "用户管理", icon: Users },
  { path: "/admin/characters", label: "角色卡管理", icon: Bot },
  { path: "/admin/apis", label: "API 管理", icon: KeyRound },
  { path: "/admin/prompt-settings", label: "提示词配置", icon: SlidersHorizontal },
  { path: "/admin/billing", label: "费用管理", icon: CreditCard }
];

const emptyCharacter = {
  name: "",
  prompt: "",
  firstMessage: "",
  apiKeyId: "",
  price: 0,
  usePrompt: true,
  useFirstMessage: true,
  useApiKey: false,
  usePrice: true,
  enabled: true
};

const emptyApi = {
  name: "",
  model: "gpt-5-mini",
  apiUrl: "https://api.openai.com/v1",
  apiKeySecret: "",
  reasoningEffort: "",
  enabled: true
};

const reasoningEffortOptions = [
  { value: "", label: "模型默认" },
  { value: "none", label: "None - 不启用推理" },
  { value: "minimal", label: "Minimal - 最少思考" },
  { value: "low", label: "Low - 轻度思考" },
  { value: "medium", label: "Medium - 标准思考" },
  { value: "high", label: "High - 深度思考" },
  { value: "xhigh", label: "XHigh - 最强思考" }
];

function reasoningEffortLabel(value) {
  return reasoningEffortOptions.find((option) => option.value === value)?.label || "模型默认";
}

function App() {
  const [path, setPath] = React.useState(window.location.pathname === "/" ? "/admin/login" : window.location.pathname);
  const [token, setToken] = React.useState(localStorage.getItem("admin_token") || "");
  const [admin, setAdmin] = React.useState(null);
  const [notice, setNotice] = React.useState("");

  const authedRequest = React.useCallback(async (url, options = {}) => {
    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || "请求失败");
      error.data = data;
      throw error;
    }
    return data;
  }, [token]);

  React.useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  React.useEffect(() => {
    if (!token) return;
    authedRequest("/api/admin/me")
      .then((data) => setAdmin(data.admin))
      .catch(() => {
        localStorage.removeItem("admin_token");
        setToken("");
        navigate("/admin/login");
      });
  }, [authedRequest, token]);

  function navigate(nextPath) {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    setNotice("");
  }

  function logout() {
    localStorage.removeItem("admin_token");
    setToken("");
    setAdmin(null);
    navigate("/admin/login");
  }

  async function login(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const data = await fetch(`${API_BASE}/api/admin/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "登录失败");
        return body;
      });
      localStorage.setItem("admin_token", data.token);
      setToken(data.token);
      setAdmin(data.admin);
      navigate("/admin/dashboard");
    } catch (error) {
      setNotice(error.message);
    }
  }

  if (!token || path === "/admin/login") {
    return (
      <main className="login-page">
        <form className="login-panel" onSubmit={login}>
          <DatabaseZap size={34} />
          <h1>ai-tavern 管理后台</h1>
          <input name="username" placeholder="管理员用户名" defaultValue="admin" required />
          <input name="password" type="password" placeholder="密码" required />
          {notice && <div className="alert">{notice}</div>}
          <button><KeyRound size={18} /> 登录</button>
        </form>
      </main>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-top">
        <div>
          <strong>ai-tavern 管理后台</strong>
          <span>{admin?.username || "admin"}</span>
        </div>
        <nav>
          {routes.map((route) => {
            const Icon = route.icon;
            return (
              <button key={route.path} className={path === route.path ? "active" : ""} onClick={() => navigate(route.path)}>
                <Icon size={17} />
                {route.label}
              </button>
            );
          })}
        </nav>
        <button className="ghost" onClick={logout}><LogOut size={17} /> 退出</button>
      </header>

      {notice && <div className="page-alert">{notice}</div>}
      {path === "/admin/dashboard" && <Dashboard request={authedRequest} />}
      {path === "/admin/users" && <UsersPage request={authedRequest} setNotice={setNotice} />}
      {path === "/admin/characters" && <CharactersPage request={authedRequest} setNotice={setNotice} />}
      {path === "/admin/apis" && <ApisPage request={authedRequest} setNotice={setNotice} />}
      {path === "/admin/prompt-settings" && <PromptSettingsPage request={authedRequest} setNotice={setNotice} />}
      {path === "/admin/billing" && <BillingPage request={authedRequest} />}
    </div>
  );
}

function Dashboard({ request }) {
  const [stats, setStats] = React.useState(null);
  React.useEffect(() => {
    request("/api/admin/stats").then((data) => setStats(data.stats));
  }, [request]);

  const items = [
    ["用户数量", stats?.users, Users],
    ["管理员数量", stats?.admins, KeyRound],
    ["角色卡数量", stats?.characters, Bot],
    ["API Key 数量", stats?.apiKeys, DatabaseZap],
    ["聊天会话数量", stats?.sessions, History],
    ["消息数量", stats?.messages, BarChart3],
    ["总消费金额", Number(stats?.totalSpend || 0).toFixed(2), CreditCard],
    ["待审核用户", stats?.pendingUsers, Users],
    ["今日新增用户", stats?.todayUsers, Users],
    ["今日对话次数", stats?.todayChats, BarChart3]
  ];

  return (
    <section className="page">
      <div className="page-title">
        <h1>首页</h1>
      </div>
      <div className="stat-grid">
        {items.map(([label, value, Icon]) => (
          <article className="stat-card" key={label}>
            <Icon size={22} />
            <span>{label}</span>
            <strong>{value ?? "-"}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function UsersPage({ request, setNotice }) {
  const [users, setUsers] = React.useState([]);
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState(null);
  const [historyUser, setHistoryUser] = React.useState(null);

  const load = React.useCallback(() => {
    request(`/api/admin/users?query=${encodeURIComponent(query)}`).then((data) => setUsers(data.users));
  }, [query, request]);

  React.useEffect(() => { load(); }, [load]);

  async function saveUser(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await request(`/api/admin/users/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    setEditing(null);
    load();
  }

  async function deleteUser(user) {
    if (!confirm(`确定删除用户 ${user.username}？`)) return;
    await request(`/api/admin/users/${user.id}`, { method: "DELETE" });
    setNotice("用户已删除");
    load();
  }

  async function approveUser(user) {
    await request(`/api/admin/users/${user.id}/approve`, { method: "POST", body: JSON.stringify({}) });
    setNotice(`${user.username} 已通过审核`);
    load();
  }

  async function rejectUser(user) {
    const reason = prompt(`拒绝 ${user.username} 的注册申请原因`, "管理员拒绝注册申请");
    if (reason === null) return;
    await request(`/api/admin/users/${user.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
    setNotice(`${user.username} 已拒绝`);
    load();
  }

  function statusLabel(status) {
    if (status === "pending") return "待审核";
    if (status === "rejected") return "已拒绝";
    return "已通过";
  }

  return (
    <section className="page">
      <div className="page-title">
        <h1>用户管理</h1>
        <form className="search" onSubmit={(event) => { event.preventDefault(); load(); }}>
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名 / 邮箱 / 用户 ID" />
        </form>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>用户 ID</th><th>用户名</th><th>邮箱</th><th>状态</th><th>余额</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.username}</td>
                <td>{user.email}</td>
                <td><span className={`status-pill ${user.status || "active"}`}>{statusLabel(user.status)}</span></td>
                <td>{Number(user.balance || 0).toFixed(2)}</td>
                <td>{new Date(user.createdAt).toLocaleString()}</td>
                <td className="actions">
                  {user.status === "pending" && <button onClick={() => approveUser(user)}><Save size={15} /> 通过</button>}
                  {user.status === "pending" && <button className="danger" onClick={() => rejectUser(user)}><Trash2 size={15} /> 拒绝</button>}
                  <button onClick={() => setEditing(user)}><Edit3 size={15} /> 编辑</button>
                  <button onClick={() => setHistoryUser(user)}><History size={15} /> 历史记录</button>
                  <button className="danger" onClick={() => deleteUser(user)}><Trash2 size={15} /> 删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal title="编辑用户" onClose={() => setEditing(null)}>
          <form className="form-grid" onSubmit={saveUser}>
            <label>用户名<input name="username" defaultValue={editing.username} /></label>
            <label>邮箱<input name="email" type="email" defaultValue={editing.email} /></label>
            <label>剩余余额<input name="balance" type="number" step="0.01" defaultValue={editing.balance} /></label>
            <button><Save size={17} /> 保存</button>
          </form>
        </Modal>
      )}
      {historyUser && <HistoryModal request={request} user={historyUser} onClose={() => setHistoryUser(null)} />}
    </section>
  );
}

function HistoryModal({ request, user, onClose }) {
  const [characters, setCharacters] = React.useState([]);
  const [characterId, setCharacterId] = React.useState("");
  const [sessions, setSessions] = React.useState([]);
  const [detail, setDetail] = React.useState(null);

  React.useEffect(() => {
    request("/api/admin/characters").then((data) => {
      setCharacters(data.characters);
      setCharacterId(data.characters[0]?.id || "");
    });
  }, [request]);

  React.useEffect(() => {
    if (!characterId) return;
    setDetail(null);
    request(`/api/admin/users/${user.id}/history?characterId=${characterId}`).then((data) => setSessions(data.sessions));
  }, [characterId, request, user.id]);

  async function openDetail(session) {
    const data = await request(`/api/admin/users/${user.id}/history/${session.id}`);
    setDetail(data);
  }

  return (
    <Modal title={`${user.username} 的历史记录`} onClose={onClose} wide>
      {detail ? (
        <div className="history-detail">
          <button className="back-button" onClick={() => setDetail(null)}>返回会话列表</button>
          <section>
            <h3>会话信息</h3>
            <div className="detail-grid">
              <span>会话 ID</span><b>{detail.session.id}</b>
              <span>标题</span><b>{detail.session.title}</b>
              <span>角色卡</span><b>{detail.character?.name || "未知"}</b>
              <span>用户</span><b>{detail.user.username} / {detail.user.email}</b>
            </div>
          </section>
          <section>
            <h3>完整系统提示词</h3>
            <pre>{detail.systemPrompt}</pre>
          </section>
          <section>
            <h3>当次真实请求快照</h3>
            {detail.requestSnapshots?.length ? (
              <div className="snapshot-list">
                {detail.requestSnapshots.map((item, index) => (
                  <details key={item.messageId} open={index === detail.requestSnapshots.length - 1}>
                    <summary>{new Date(item.createdAt).toLocaleString()} / {item.snapshot.provider?.model || "未知模型"}</summary>
                    <pre>{JSON.stringify(item.snapshot, null, 2)}</pre>
                  </details>
                ))}
              </div>
            ) : (
              <div className="empty">旧消息未保存请求快照</div>
            )}
          </section>
          <section>
            <h3>角色卡详情</h3>
            <pre>{JSON.stringify(detail.character, null, 2)}</pre>
          </section>
          <section>
            <h3>请求上下文</h3>
            <pre>{JSON.stringify(detail.systemContext, null, 2)}</pre>
          </section>
          <section>
            <h3>完整消息记录</h3>
            <div className="detail-messages">
              {detail.messages.map((message) => (
                <article key={message.id}>
                  <strong>{message.role}</strong>
                  <span>{new Date(message.createdAt).toLocaleString()}</span>
                  <p>{message.content}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <label>角色卡
              <select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
                {characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}
              </select>
            </label>
          </div>
          <div className="history-list">
            {sessions.map((session) => (
              <article key={session.id}>
                <strong>{session.title}</strong>
                <span>{new Date(session.updatedAt).toLocaleString()}</span>
                <p>消息数量：{session.messages.length}</p>
                <button onClick={() => openDetail(session)}><History size={15} /> 查看完整记录</button>
              </article>
            ))}
            {!sessions.length && <div className="empty">暂无历史记录</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

function CharactersPage({ request, setNotice }) {
  const [characters, setCharacters] = React.useState([]);
  const [apis, setApis] = React.useState([]);
  const [editing, setEditing] = React.useState(null);

  const load = React.useCallback(() => {
    request("/api/admin/characters").then((data) => setCharacters(data.characters));
    request("/api/admin/apis").then((data) => setApis(data.apiKeys));
  }, [request]);

  React.useEffect(() => { load(); }, [load]);

  async function saveCharacter(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const body = {
      ...payload,
      price: Number(payload.price || 0),
      usePrompt: form.has("usePrompt"),
      useFirstMessage: form.has("useFirstMessage"),
      useApiKey: form.has("useApiKey"),
      usePrice: form.has("usePrice"),
      enabled: form.has("enabled")
    };
    const path = editing.id ? `/api/admin/characters/${editing.id}` : "/api/admin/characters";
    const method = editing.id ? "PATCH" : "POST";
    await request(path, { method, body: JSON.stringify(body) });
    setEditing(null);
    load();
  }

  async function deleteCharacter(character) {
    if (!confirm(`确定删除角色卡 ${character.name}？`)) return;
    await request(`/api/admin/characters/${character.id}`, { method: "DELETE" });
    setNotice("角色卡已删除");
    load();
  }

  return (
    <section className="page">
      <div className="page-title">
        <h1>角色卡管理</h1>
        <button className="primary-action" onClick={() => setEditing(emptyCharacter)}><Plus size={17} /> 新建角色卡</button>
      </div>
      <div className="card-grid">
        {characters.map((character) => (
          <article className="manage-card" key={character.id}>
            <div className="card-head">
              <Bot size={22} />
              <div>
                <strong>{character.name}</strong>
                <span>{character.enabled ? "已启用" : "已停用"} {character.isDefault ? " / 默认角色卡" : ""}</span>
              </div>
            </div>
            <p>{character.usePrompt ? character.prompt || "未填写 Prompt" : "Prompt 未启用"}</p>
            <div className="meta">价格：{character.usePrice ? Number(character.price || 0).toFixed(2) : "未启用"}</div>
            <div className="actions">
              <button onClick={() => setEditing(character)}><Edit3 size={15} /> 编辑</button>
              <button className="danger" disabled={character.isDefault} onClick={() => deleteCharacter(character)}><Trash2 size={15} /> 删除</button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? "编辑角色卡" : "新建角色卡"} onClose={() => setEditing(null)} wide>
          <form className="form-grid" onSubmit={saveCharacter}>
            <label>角色卡名称<input name="name" defaultValue={editing.name} required disabled={editing.isDefault} /></label>
            <Toggle name="usePrompt" label="启用 Prompt" defaultChecked={editing.usePrompt} />
            <label className="wide-field">Prompt<textarea name="prompt" defaultValue={editing.prompt} /></label>
            <Toggle name="useFirstMessage" label="启用首次对话内容" defaultChecked={editing.useFirstMessage} />
            <label className="wide-field">首次对话内容<textarea name="firstMessage" defaultValue={editing.firstMessage} /></label>
            <Toggle name="useApiKey" label="启用 API Key" defaultChecked={editing.useApiKey} />
            <label>使用的 API Key
              <select name="apiKeyId" defaultValue={editing.apiKeyId || ""}>
                <option value="">不绑定</option>
                {apis.map((api) => <option key={api.id} value={api.id}>{api.name}</option>)}
              </select>
            </label>
            <Toggle name="usePrice" label="启用单次对话价格" defaultChecked={editing.usePrice} />
            <label>单次对话价格<input name="price" type="number" step="0.01" defaultValue={editing.price} /></label>
            <Toggle name="enabled" label="是否启用" defaultChecked={editing.enabled} />
            <button><Save size={17} /> 保存</button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function PromptSettingsPage({ request, setNotice }) {
  const [settings, setSettings] = React.useState(null);

  React.useEffect(() => {
    request("/api/admin/prompt-settings").then((data) => setSettings(data.settings));
  }, [request]);

  async function saveSettings(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const body = {
      ...payload,
      maxHistoryMessages: Number(payload.maxHistoryMessages || 40),
      compressionThresholdMessages: Number(payload.compressionThresholdMessages || 60),
      includeUserEnvironment: form.has("includeUserEnvironment"),
      includeAttachmentsInPrompt: form.has("includeAttachmentsInPrompt")
    };
    const data = await request("/api/admin/prompt-settings", { method: "PATCH", body: JSON.stringify(body) });
    setSettings(data.settings);
    setNotice("提示词配置已保存");
  }

  if (!settings) {
    return (
      <section className="page">
        <div className="page-title"><h1>提示词配置</h1></div>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-title">
        <h1>提示词配置</h1>
      </div>
      <form className="form-grid prompt-settings" onSubmit={saveSettings}>
        <label className="wide-field">系统提示词模板
          <textarea name="systemTemplate" defaultValue={settings.systemTemplate} />
        </label>
        <label>历史记录策略
          <select name="historyStrategy" defaultValue={settings.historyStrategy}>
            <option value="recent_with_summary">压缩较早历史 + 保留最近消息</option>
            <option value="recent">只保留最近消息</option>
          </select>
        </label>
        <label>最近消息数量
          <input name="maxHistoryMessages" type="number" min="1" max="200" defaultValue={settings.maxHistoryMessages} />
        </label>
        <label>压缩摘要最多摘录消息数
          <input name="compressionThresholdMessages" type="number" min="1" max="500" defaultValue={settings.compressionThresholdMessages} />
        </label>
        <label>Prompt Cache
          <select name="promptCacheRetention" defaultValue={settings.promptCacheRetention}>
            <option value="in_memory">默认内存缓存</option>
            <option value="24h">OpenAI 24h 扩展缓存</option>
          </select>
        </label>
        <Toggle name="includeUserEnvironment" label="发送用户浏览器时区 / 系统信息 / UA / 基础信息" defaultChecked={settings.includeUserEnvironment} />
        <Toggle name="includeAttachmentsInPrompt" label="发送用户上传文件内容" defaultChecked={settings.includeAttachmentsInPrompt} />
        <div className="template-help wide-field">
          可用变量：{"{{characterName}}"}、{"{{characterPrompt}}"}、{"{{localTime}}"}、{"{{timezone}}"}、{"{{systemInfo}}"}、{"{{userAgent}}"}、{"{{browserLanguage}}"}、{"{{screen}}"}、{"{{userProfile}}"}
        </div>
        <button><Save size={17} /> 保存配置</button>
      </form>
    </section>
  );
}

function ApisPage({ request, setNotice }) {
  const [apis, setApis] = React.useState([]);
  const [editing, setEditing] = React.useState(null);

  const load = React.useCallback(() => {
    request("/api/admin/apis").then((data) => setApis(data.apiKeys));
  }, [request]);

  React.useEffect(() => { load(); }, [load]);

  async function saveApi(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.enabled = form.has("enabled");
    const path = editing.id ? `/api/admin/apis/${editing.id}` : "/api/admin/apis";
    const method = editing.id ? "PATCH" : "POST";
    await request(path, { method, body: JSON.stringify(payload) });
    setEditing(null);
    load();
  }

  async function deleteApi(api, force = false) {
    try {
      await request(`/api/admin/apis/${api.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      setNotice("API Key 已删除");
      load();
    } catch (error) {
      if (error.data?.requiresConfirmation && confirm(error.data.message)) {
        await deleteApi(api, true);
      } else {
        setNotice(error.message);
      }
    }
  }

  return (
    <section className="page">
      <div className="page-title">
        <h1>API 管理</h1>
        <button className="primary-action" onClick={() => setEditing(emptyApi)}><Plus size={17} /> 新增 API</button>
      </div>
      <div className="card-grid">
        {apis.map((api) => (
          <article className="manage-card" key={api.id}>
            <div className="card-head">
              <KeyRound size={22} />
              <div>
                <strong>{api.name}</strong>
                <span>{api.enabled ? "已启用" : "已停用"} / {api.hasSecret ? "已配置密钥" : "未配置密钥"}</span>
              </div>
            </div>
            <div className="meta">模型：{api.model}</div>
            <div className="meta">思考程度：{reasoningEffortLabel(api.reasoningEffort)}</div>
            <div className="meta">地址：{api.apiUrl}</div>
            <div className="actions">
              <button onClick={() => setEditing(api)}><Edit3 size={15} /> 编辑</button>
              <button className="danger" onClick={() => deleteApi(api)}><Trash2 size={15} /> 删除</button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? "编辑 API" : "新增 API"} onClose={() => setEditing(null)}>
          <form className="form-grid" onSubmit={saveApi}>
            <label>API Key 名称<input name="name" defaultValue={editing.name} required /></label>
            <label>调用模型名称<input name="model" defaultValue={editing.model} required /></label>
            <label>
              模型思考程度
              <select name="reasoningEffort" defaultValue={editing.reasoningEffort || ""}>
                {reasoningEffortOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>API 地址<input name="apiUrl" defaultValue={editing.apiUrl} required /></label>
            <label>API Key 密文<input name="apiKeySecret" type="password" placeholder={editing.id ? "留空则不修改" : "sk-..."} /></label>
            <Toggle name="enabled" label="是否启用" defaultChecked={editing.enabled} />
            <button><Save size={17} /> 保存</button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function BillingPage({ request }) {
  const [billing, setBilling] = React.useState(null);
  React.useEffect(() => {
    request("/api/admin/billing").then(setBilling);
  }, [request]);

  return (
    <section className="page">
      <div className="page-title">
        <h1>费用管理</h1>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>角色卡</th><th>调用次数</th><th>消费金额</th></tr></thead>
          <tbody>
            {(billing?.byCharacter || []).map((row) => (
              <tr key={row.characterId}>
                <td>{row.characterName}</td>
                <td>{row.calls}</td>
                <td>{Number(row.amount || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="total">总消费金额：{Number(billing?.total || 0).toFixed(2)}</div>
    </section>
  );
}

function Modal({ title, onClose, children, wide = false }) {
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

function Toggle({ name, label, defaultChecked }) {
  return (
    <label className="toggle">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}

createRoot(document.getElementById("root")).render(<App />);
