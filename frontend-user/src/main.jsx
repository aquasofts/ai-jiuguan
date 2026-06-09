import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ChevronDown, FileText, LogIn, LogOut, Menu, MessageSquarePlus, Paperclip, Send, Sparkles, UserRound, WalletCards, X } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:2255" : "");
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 750 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 60000;

function App() {
  const [token, setToken] = React.useState(localStorage.getItem("user_token") || "");
  const [user, setUser] = React.useState(null);
  const [characters, setCharacters] = React.useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = React.useState("character_default");
  const [sessions, setSessions] = React.useState([]);
  const [currentSession, setCurrentSession] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState([]);
  const [avatarOpen, setAvatarOpen] = React.useState(false);
  const [characterOpen, setCharacterOpen] = React.useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [mobileMenuClosing, setMobileMenuClosing] = React.useState(false);
  const [authOpen, setAuthOpen] = React.useState(false);
  const [authMode, setAuthMode] = React.useState("login");
  const [authNotice, setAuthNotice] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [dragActive, setDragActive] = React.useState(false);
  const messagesEndRef = React.useRef(null);
  const fileInputRef = React.useRef(null);
  const dragDepthRef = React.useRef(0);

  const selectedCharacter = characters.find((item) => item.id === selectedCharacterId) || characters[0];
  const mobileMenuVisible = mobileMenuOpen || mobileMenuClosing;

  function formatSessionTime(value) {
    if (!value) return "刚刚";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚";
    return date.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function openMobileMenu() {
    setAvatarOpen(false);
    setCharacterOpen(false);
    setMobileMenuClosing(false);
    setMobileMenuOpen(true);
  }

  function closeMobileMenu() {
    if (!mobileMenuVisible) return;
    setMobileMenuOpen(false);
    setMobileMenuClosing(true);
  }

  function hideMobileMenuNow() {
    setMobileMenuOpen(false);
    setMobileMenuClosing(false);
  }

  function openAuthModal(mode = "login") {
    setAvatarOpen(false);
    hideMobileMenuNow();
    setAuthNotice("");
    setNotice("");
    setAuthMode(mode);
    setAuthOpen(true);
  }

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  React.useEffect(() => {
    if (!mobileMenuClosing) return undefined;
    const timeout = window.setTimeout(() => setMobileMenuClosing(false), 190);
    return () => window.clearTimeout(timeout);
  }, [mobileMenuClosing]);

  React.useEffect(() => {
    if (!mobileMenuVisible) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event) {
      if (event.key === "Escape") closeMobileMenu();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuVisible]);

  const request = React.useCallback(async (path, options = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "请求失败");
    return data;
  }, [token]);

  React.useEffect(() => {
    request("/api/characters").then((data) => {
      setCharacters(data.characters);
      if (!data.characters.some((item) => item.id === selectedCharacterId)) {
        setSelectedCharacterId(data.characters[0]?.id || "");
      }
    }).catch((error) => setNotice(error.message));
  }, [request]);

  React.useEffect(() => {
    if (!token) return;
    request("/api/me")
      .then((data) => setUser(data.user))
      .catch(() => {
        localStorage.removeItem("user_token");
        setToken("");
      });
  }, [request, token]);

  React.useEffect(() => {
    if (!token || !selectedCharacterId) {
      setSessions([]);
      setCurrentSession(null);
      setMessages([]);
      return;
    }
    request(`/api/sessions?characterId=${encodeURIComponent(selectedCharacterId)}`)
      .then((data) => {
        setSessions(data.sessions);
        if (!data.sessions.some((item) => item.id === currentSession?.id)) {
          setCurrentSession(null);
          setMessages([]);
        }
      })
      .catch((error) => setNotice(error.message));
  }, [request, token, selectedCharacterId]);

  async function submitAuth(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const data = await request(authMode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (data.pendingApproval) {
        setAuthMode("login");
        setAuthNotice(data.message || "注册申请已提交，请等待管理员审核");
        return;
      }
      localStorage.setItem("user_token", data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthOpen(false);
      setAuthNotice("");
      setNotice("");
    } catch (error) {
      setAuthNotice(error.message);
    }
  }

  function logout() {
    localStorage.removeItem("user_token");
    setToken("");
    setUser(null);
    setSessions([]);
    setMessages([]);
    setCurrentSession(null);
  }

  async function newChat() {
    if (!token) {
      openAuthModal("login");
      return;
    }
    const data = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ characterId: selectedCharacterId })
    });
    setCurrentSession(data.session);
    setMessages(data.messages);
    setSessions((items) => [data.session, ...items]);
    closeMobileMenu();
  }

  async function openSession(session) {
    const data = await request(`/api/sessions/${session.id}/messages`);
    setCurrentSession(data.session);
    setMessages(data.messages);
    closeMobileMenu();
  }

  function selectCharacter(characterId) {
    setSelectedCharacterId(characterId);
    setCharacterOpen(false);
    closeMobileMenu();
  }

  function collectClientContext() {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const screenInfo = window.screen
      ? `${window.screen.width}x${window.screen.height}; avail=${window.screen.availWidth}x${window.screen.availHeight}; dpr=${window.devicePixelRatio || 1}`
      : "未知";
    const uaData = navigator.userAgentData
      ? `brands=${navigator.userAgentData.brands?.map((item) => `${item.brand}/${item.version}`).join(", ") || "未知"}; mobile=${navigator.userAgentData.mobile}; platform=${navigator.userAgentData.platform}`
      : "userAgentData=不可用";

    return {
      timezone: resolved.timeZone || "未知",
      localTime: new Date().toLocaleString(),
      browserLanguage: navigator.language || "未知",
      userAgent: navigator.userAgent,
      screen: screenInfo,
      systemInfo: [
        `platform=${navigator.platform || "未知"}`,
        `languages=${(navigator.languages || []).join(",") || navigator.language || "未知"}`,
        `hardwareConcurrency=${navigator.hardwareConcurrency || "未知"}`,
        `deviceMemory=${navigator.deviceMemory || "未知"}`,
        `maxTouchPoints=${navigator.maxTouchPoints ?? "未知"}`,
        `cookieEnabled=${navigator.cookieEnabled}`,
        `online=${navigator.onLine}`,
        `vendor=${navigator.vendor || "未知"}`,
        uaData
      ].join("; ")
    };
  }

  function canReadAsText(file) {
    return file.type.startsWith("text/")
      || ["application/json", "application/xml", "application/javascript", "image/svg+xml"].includes(file.type)
      || /\.(txt|md|csv|json|xml|html|css|js|jsx|ts|tsx|py|java|go|rs|sql|yml|yaml|log)$/i.test(file.name);
  }

  function readAttachment(file) {
    return new Promise((resolve) => {
      const base = {
        id: `file_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        text: "",
        truncated: file.size > MAX_ATTACHMENT_BYTES
      };
      if (!canReadAsText(file)) return resolve(base);
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        resolve({
          ...base,
          text: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
          truncated: base.truncated || text.length > MAX_ATTACHMENT_TEXT_CHARS
        });
      };
      reader.onerror = () => resolve(base);
      reader.readAsText(file.slice(0, MAX_ATTACHMENT_BYTES));
    });
  }

  async function queueFiles(files) {
    const selected = Array.from(files || []).filter(Boolean);
    if (!selected.length) return false;
    const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (!slots) {
      setNotice(`最多支持 ${MAX_ATTACHMENTS} 个附件`);
      return true;
    }
    const next = await Promise.all(selected.slice(0, slots).map(readAttachment));
    setAttachments((items) => [...items, ...next].slice(0, MAX_ATTACHMENTS));
    setNotice(selected.length > slots ? `已添加前 ${slots} 个附件` : "");
    return true;
  }

  function getTransferFiles(dataTransfer) {
    const items = Array.from(dataTransfer?.items || []);
    const files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    return files.length ? files : Array.from(dataTransfer?.files || []);
  }

  function hasTransferFiles(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    const items = Array.from(dataTransfer?.items || []);
    return types.includes("Files") || items.some((item) => item.kind === "file") || Boolean(dataTransfer?.files?.length);
  }

  async function handleFiles(event) {
    await queueFiles(event.target.files);
    event.target.value = "";
  }

  function handleDragEnter(event) {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event) {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event) {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function handleDrop(event) {
    const files = getTransferFiles(event.dataTransfer);
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (!files.length) return;
    await queueFiles(files);
  }

  async function handlePaste(event) {
    const files = getTransferFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    await queueFiles(files);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if ((!content && !attachments.length) || streaming) return;
    if (!token) {
      openAuthModal("login");
      return;
    }

    let session = currentSession;
    if (!session) {
      const data = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ characterId: selectedCharacterId })
      });
      session = data.session;
      setCurrentSession(session);
      setMessages(data.messages);
      setSessions((items) => [session, ...items]);
    }

    const localUserMessage = {
      id: `local_${Date.now()}`,
      role: "user",
      content,
      attachments,
      createdAt: new Date().toISOString()
    };
    const localAssistantMessage = {
      id: `stream_${Date.now()}`,
      role: "assistant",
      content: "",
      loading: true,
      createdAt: new Date().toISOString()
    };
    setDraft("");
    setAttachments([]);
    setStreaming(true);
    setNotice("");
    setMessages((items) => [...items, localUserMessage, localAssistantMessage]);

    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          sessionId: session.id,
          message: content,
          attachments: attachments.map(({ id, ...file }) => file),
          clientContext: collectClientContext()
        })
      });
      if (!response.ok || !response.body) throw new Error("流式连接失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const raw of events) {
          const lines = raw.split("\n");
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const dataLine = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
          const data = dataLine ? JSON.parse(dataLine) : {};
          if (eventName === "delta") {
            setMessages((items) => items.map((item) => item.id === localAssistantMessage.id ? { ...item, content: item.content + data.delta } : item));
          }
          if (eventName === "error") {
            setNotice(data.message);
            setMessages((items) => items.filter((item) => item.id !== localAssistantMessage.id));
          }
          if (eventName === "done") {
            setMessages((items) => items.map((item) => item.id === localAssistantMessage.id ? data.message : item));
            setUser((current) => current ? { ...current, balance: data.balance } : current);
          }
        }
      }
    } catch (error) {
      setNotice(error.message);
      setMessages((items) => items.filter((item) => item.id !== localAssistantMessage.id));
    } finally {
      setStreaming(false);
      request(`/api/sessions?characterId=${encodeURIComponent(selectedCharacterId)}`).then((data) => setSessions(data.sessions)).catch(() => {});
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Bot size={24} />
          <div>
            <strong>ai-tavern</strong>
            <span>{selectedCharacter?.name || "默认模型"}</span>
          </div>
        </div>

        <div className="sessions">
          {token ? sessions.map((session) => (
            <button
              className={`session ${currentSession?.id === session.id ? "active" : ""}`}
              key={session.id}
              onClick={() => openSession(session)}
            >
              <MessageSquarePlus size={16} />
              <span>{session.title}</span>
            </button>
          )) : (
            <div className="empty">
              <Sparkles size={18} />
              登录后会在这里同步云端历史记录
            </div>
          )}
        </div>

        <div className="sidebar-actions">
          <div className="role-picker">
            <button className="secondary" onClick={() => setCharacterOpen((open) => !open)}>
              <Menu size={17} />
              <span>角色卡选择</span>
              <ChevronDown size={16} />
            </button>
            {characterOpen && (
              <div className="popover roles">
                {characters.map((character) => (
                  <button
                    key={character.id}
                    className={character.id === selectedCharacterId ? "chosen" : ""}
                    onClick={() => selectCharacter(character.id)}
                  >
                    <strong>{character.name}</strong>
                    {character.usePrice && <span>{Number(character.price || 0).toFixed(2)} / 次</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="primary" onClick={newChat}>
            <MessageSquarePlus size={18} />
            新建聊天
          </button>
        </div>
      </aside>

      <main
        className={`chat ${dragActive ? "dragging" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        <header className="topbar">
          <button
            className="mobile-menu-trigger"
            type="button"
            onClick={openMobileMenu}
            aria-label="打开菜单"
            aria-expanded={mobileMenuVisible}
            aria-controls="mobile-navigation"
          >
            <Menu size={22} />
          </button>
          <div className="topbar-title">
            <h1>{selectedCharacter?.name || "默认模型"}</h1>
            <p>{currentSession?.title || "新对话"}</p>
          </div>
          <div className="avatar-wrap">
            <button className="avatar" onClick={() => setAvatarOpen((open) => !open)} aria-label="用户">
              <UserRound size={21} />
            </button>
            {avatarOpen && (
              <div className="popover account">
                {user ? (
                  <>
                    <div className="account-card">
                      <strong>{user.username}</strong>
                      <span>{user.email}</span>
                      <span className="balance"><WalletCards size={15} /> 余额 {Number(user.balance || 0).toFixed(2)}</span>
                    </div>
                    <button onClick={logout}><LogOut size={16} /> 退出登录</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => openAuthModal("login")}><LogIn size={16} /> 登录</button>
                    <button onClick={() => openAuthModal("register")}><UserRound size={16} /> 注册</button>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        <section className="messages" aria-live="polite">
          {notice && <div className="notice">{notice}</div>}
          {messages.length === 0 ? (
            <div className="welcome">
              <Bot size={42} />
              <h2>开始一场新的对话</h2>
              <p>选择角色卡后发送消息；不同角色卡的会话历史会互相隔离。</p>
            </div>
          ) : messages.map((message) => {
            const body = message.loading && !message.content ? <div className="typing">AI 正在回复...</div> : (
              <>
                {message.attachments?.length > 0 && (
                  <div className="attachment-list">
                    {message.attachments.map((file) => (
                      <span className="attachment-chip" key={file.id || file.name}>
                        <FileText size={14} />
                        {file.name}
                      </span>
                    ))}
                  </div>
                )}
                {message.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                    code({ inline, children, ...props }) {
                      return inline ? <code {...props}>{children}</code> : <pre><code {...props}>{children}</code></pre>;
                    }
                  }}>
                    {message.content}
                  </ReactMarkdown>
                ) : null}
              </>
            );

            return message.role === "user" ? (
              <article className="message user" key={message.id}>
                <div className="bubble-head">你</div>
                <div className="bubble user">{body}</div>
              </article>
            ) : (
              <article className="bubble assistant" key={message.id}>
                <div className="bubble-head">{selectedCharacter?.name || "AI"}</div>
                {body}
              </article>
            );
          })}
          <div className="messages-end" ref={messagesEndRef} />
        </section>

        <form className={`composer ${attachments.length ? "has-files" : ""}`} onSubmit={sendMessage}>
          <div className="composer-box">
            {attachments.length > 0 && (
              <div className="pending-files">
                {attachments.map((file) => (
                  <span className="pending-file" key={file.id}>
                    <FileText size={14} />
                    {file.name}
                    <button type="button" onClick={() => setAttachments((items) => items.filter((item) => item.id !== file.id))} aria-label={`移除 ${file.name}`}>
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form.requestSubmit();
                }
              }}
              placeholder={token ? "输入消息" : "登录后开始聊天"}
            />
          </div>
          <input ref={fileInputRef} className="file-input" type="file" multiple onChange={handleFiles} />
          <button type="button" className="attach" disabled={streaming || attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={18} />
          </button>
          <button className="send" disabled={streaming || (!draft.trim() && !attachments.length)}>
            <Send size={18} />
          </button>
        </form>

        {dragActive && (
          <div className="drop-overlay" aria-live="polite">
            <div className="drop-target">
              <FileText size={26} />
              <strong>松手添加文件</strong>
              <span>最多 {MAX_ATTACHMENTS} 个附件</span>
            </div>
          </div>
        )}
      </main>

      {mobileMenuVisible && (
        <div className={`mobile-menu-panel ${mobileMenuClosing ? "closing" : ""}`} id="mobile-navigation">
          <header className="mobile-menu-head">
            <div>
              <strong>ai-tavern</strong>
              <span>{selectedCharacter?.name || "默认模型"}</span>
            </div>
            <button type="button" className="mobile-close" onClick={closeMobileMenu} aria-label="关闭菜单">
              <X size={22} />
            </button>
          </header>

          <div className="mobile-menu-body">
            <button className="mobile-new-chat" onClick={newChat}>
              <MessageSquarePlus size={19} />
              <span>新建聊天</span>
            </button>

            <section className="mobile-menu-section">
              <div className="mobile-section-title">历史记录</div>
              <div className="mobile-list">
                {token ? sessions.length ? sessions.map((session) => (
                    <button
                      className={`mobile-list-item ${currentSession?.id === session.id ? "active" : ""}`}
                      key={session.id}
                      onClick={() => openSession(session)}
                    >
                      <MessageSquarePlus size={17} />
                      <span>
                        <strong>{session.title}</strong>
                        <small>{formatSessionTime(session.updatedAt)}</small>
                      </span>
                    </button>
                  )) : (
                    <div className="mobile-empty">
                      <Sparkles size={18} />
                      暂无历史记录
                    </div>
                  ) : (
                  <div className="mobile-empty">
                    <Sparkles size={18} />
                    登录后同步历史记录
                  </div>
                )}
              </div>
            </section>

            <section className="mobile-menu-section">
              <div className="mobile-section-title">角色卡管理</div>
              <div className="mobile-role-list">
                {characters.map((character) => (
                  <button
                    key={character.id}
                    className={`mobile-role-card ${character.id === selectedCharacterId ? "chosen" : ""}`}
                    onClick={() => selectCharacter(character.id)}
                  >
                    <span>
                      <strong>{character.name}</strong>
                      {character.usePrice && <em>{Number(character.price || 0).toFixed(2)} / 次</em>}
                    </span>
                    {character.id === selectedCharacterId && <small>当前</small>}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {authOpen && (
        <div className="modal-backdrop auth-backdrop" onMouseDown={() => setAuthOpen(false)}>
          <form className="modal auth-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={submitAuth}>
            <h2>{authMode === "login" ? "登录" : "注册"}</h2>
            {authNotice && <div className="auth-notice">{authNotice}</div>}
            {authMode === "register" && <input name="username" placeholder="用户名" />}
            <input name="email" type="email" placeholder="邮箱" required />
            <input name="password" type="password" placeholder="密码" required />
            <button className="primary">{authMode === "login" ? "登录" : "创建账号"}</button>
            <button type="button" className="link" onClick={() => { setAuthNotice(""); setAuthMode(authMode === "login" ? "register" : "login"); }}>
              {authMode === "login" ? "没有账号？注册" : "已有账号？登录"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
