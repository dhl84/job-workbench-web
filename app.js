/* Job Workbench page. Live when it reaches the worker on the PC with the saved token.
   Anywhere else it reads and writes the tracker and the notes in Supabase after a
   sign-in. */
(function () {
  "use strict";

  var STATUS_LABELS = {
    saved: "Saved", ready: "CV ready", applied: "Applied", interviewing: "Interviewing",
    offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", closed: "Closed",
    presumed_unsuccessful: "Presumed unsuccessful"
  };
  var STATUS_TONE = {
    saved: "muted", ready: "accent", applied: "accent", interviewing: "good", offer: "good",
    rejected: "bad", withdrawn: "muted", closed: "muted", presumed_unsuccessful: "warn"
  };
  var TABS = [
    ["active", "Active", ["saved", "ready", "applied", "interviewing", "offer"]],
    ["prepare", "To prepare", ["saved", "ready"]],
    ["applied", "Applied", ["applied"]],
    ["interviewing", "Interviewing", ["interviewing", "offer"]],
    ["closed", "Closed", ["rejected", "withdrawn", "closed", "presumed_unsuccessful"]],
    ["all", "All", null]
  ];
  var TASK_ORDER = ["fit", "cv", "cover", "answers", "research", "interview"];
  var POSTING = {
    live: ["Live", "good"], changed: ["Changed", "warn"], reposted: ["Reposted", "accent"],
    closed: ["Closed", "bad"], not_found: ["Not found", "muted"], unknown: ["Unknown", "muted"]
  };

  var S = {
    data: null, live: false, cloud: false, worker: "", tab: "active", q: "",
    selected: null, files: {}, notes: {}, pollTimer: null, logTask: null, logOffset: 0, logTimer: null
  };

  // ------------------------------------------------------------ helpers ---
  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem("jw." + key) || "";
      if (value === "") localStorage.removeItem("jw." + key); else localStorage.setItem("jw." + key, value);
    } catch (e) { return ""; }
    return value;
  }
  function settings() {
    return {
      token: store("token"), workerUrl: store("workerUrl"), provider: store("provider") || "claude",
      ollamaModel: store("ollamaModel"), claudeModel: store("claudeModel"), codexModel: store("codexModel")
    };
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  }
  function daysUntil(iso) {
    if (!iso || !S.data) return null;
    var today = new Date((S.data.today || new Date().toISOString().slice(0, 10)) + "T12:00:00");
    return Math.round((new Date(iso + "T12:00:00") - today) / 86400000);
  }
  function pill(text, tone) { return '<span class="pill pill-' + (tone || "muted") + '">' + esc(text) + "</span>"; }
  function statusPill(row) { var s = row.display_status || row.application_status; return pill(STATUS_LABELS[s] || s, STATUS_TONE[s]); }
  function verdictPill(v) {
    if (!v) return '<span class="muted">—</span>';
    var tone = v === "APPLY" ? "good" : v === "SKIP" ? "bad" : "warn";
    return pill(v.charAt(0) + v.slice(1).toLowerCase(), tone);
  }
  function postingPill(row) {
    var p = POSTING[row.posting_status];
    if (!p) return '<span class="muted">—</span>';
    return '<span title="' + esc(row.posting_summary) + '">' + pill(p[0], p[1]) + "</span>";
  }
  function rows() { return (S.data && S.data.opportunities) || []; }
  function find(id) { return rows().filter(function (r) { return r.opportunity_id === id; })[0]; }
  function fileUrl(href) {
    if (!S.live) return "";
    return S.worker + "/" + href + (href.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(settings().token);
  }
  // A file of the application folder, from the worker. Away from home the Notes list
  // opens the same file from Supabase.
  function folderFile(row, name) {
    if (!S.live) return "";
    return fileUrl("files/" + row.application_folder + "/" + name.split("/").map(encodeURIComponent).join("/"));
  }

  // ----------------------------------------------------------- supabase ---
  // PostgREST and GoTrue over fetch. The workbench carries no libraries and this
  // keeps it that way. The anon key grants nothing on its own, because the row
  // policy refuses a request that carries no session.
  var EDITABLE = ["employer_name", "job_title", "application_status", "applied_at",
    "response_at", "interview_at", "employer_url", "application_url", "location",
    "working_pattern", "package_summary", "closing_date", "notes", "archived",
    "cv_pdf", "submitted_version"];

  var SB = {
    conf: function () {
      var base = window.JW_SUPABASE || {};
      return { url: (store("supabaseUrl") || base.url || "").replace(/\/+$/, ""),
               key: store("supabaseKey") || base.anonKey || "" };
    },
    session: function (value) {
      if (value === undefined) {
        try { return JSON.parse(store("session") || "null"); } catch (e) { return null; }
      }
      store("session", value ? JSON.stringify(value) : "");
      return value;
    },
    email: function () { var s = this.session(); return (s && s.user && s.user.email) || ""; },
    configured: function () { var c = this.conf(); return !!(c.url && c.key); },
    ready: function () { return this.configured() && !!this.session() && !this.needsCode(); },
    auth: function (grant, body) {
      var c = this.conf();
      return fetch(c.url + "/auth/v1/token?grant_type=" + grant, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: c.key },
        body: JSON.stringify(body), credentials: "omit"
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok || !d.access_token) {
            if (res.status === 400 || res.status === 401) SB.session(null);
            throw new Error(d.msg || d.error_description || d.error || ("HTTP " + res.status));
          }
          d.expires_at = Date.now() + ((d.expires_in || 3600) * 1000);
          SB.session(d);
          return d;
        });
      });
    },
    signIn: function (email, password) {
      return this.auth("password", { email: email, password: password });
    },
    signOut: function () { this.session(null); },
    // The second sign-in factor, an authenticator app. A session from the password
    // alone has the level "aal1". After the code it has "aal2". Once
    // supabase/manual/require_second_factor.sql runs, an aal1 session reads nothing.
    aal: function () {
      var s = this.session();
      try {
        var part = s.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(part)).aal || "";
      } catch (e) { return ""; }
    },
    factor: function () {
      var s = this.session(), list = (s && s.user && s.user.factors) || [];
      return list.filter(function (f) { return f.status === "verified" && f.factor_type === "totp"; })[0] || null;
    },
    needsCode: function () { return !!this.session() && !!this.factor() && this.aal() !== "aal2"; },
    authCall: function (path, method, body) {
      var c = this.conf();
      return this.token().then(function (tok) {
        return fetch(c.url + "/auth/v1/" + path, {
          method: method || "GET", credentials: "omit",
          headers: { "Content-Type": "application/json", apikey: c.key, Authorization: "Bearer " + tok },
          body: body ? JSON.stringify(body) : undefined
        });
      }).then(function (res) {
        return res.text().then(function (text) {
          var d = text ? JSON.parse(text) : {};
          if (!res.ok) throw new Error(d.msg || d.message || d.error_description || d.error || ("HTTP " + res.status));
          return d;
        });
      });
    },
    verifyCode: function (factorId, code) {
      return this.authCall("factors/" + factorId + "/challenge", "POST", {}).then(function (ch) {
        return SB.authCall("factors/" + factorId + "/verify", "POST", { challenge_id: ch.id, code: code });
      }).then(function (d) {
        if (!d.access_token) throw new Error("The code was not accepted.");
        d.expires_at = Date.now() + ((d.expires_in || 3600) * 1000);
        SB.session(d);
        return d;
      });
    },
    // The user record, so a session saved before an enrolment learns of the factor.
    refreshUser: function () {
      return this.authCall("user").then(function (user) {
        var s = SB.session();
        if (s) { s.user = user; SB.session(s); }
        return user;
      });
    },
    // Start an enrolment. An earlier attempt that was never confirmed blocks a new
    // one, so remove it first.
    enrol: function () {
      return this.refreshUser().then(function (user) {
        var stale = (user.factors || []).filter(function (f) { return f.status !== "verified"; });
        return Promise.all(stale.map(function (f) { return SB.authCall("factors/" + f.id, "DELETE"); }));
      }).then(function () {
        return SB.authCall("factors", "POST", { factor_type: "totp",
          friendly_name: "Authenticator " + new Date().toISOString().slice(0, 10) });
      });
    },
    token: function () {
      var held = this.session();
      if (!held) return Promise.reject(new Error("Not signed in."));
      if (held.access_token && held.expires_at > Date.now() + 60000) {
        return Promise.resolve(held.access_token);
      }
      return this.auth("refresh_token", { refresh_token: held.refresh_token })
        .then(function (d) { return d.access_token; });
    },
    rest: function (path, method, body, prefer) {
      var c = this.conf();
      return this.token().then(function (tok) {
        var headers = { "Content-Type": "application/json", apikey: c.key,
                        Authorization: "Bearer " + tok };
        if (prefer) headers.Prefer = prefer;
        return fetch(c.url + "/rest/v1/" + path, {
          method: method || "GET", headers: headers,
          body: body ? JSON.stringify(body) : undefined, credentials: "omit"
        }).then(function (res) {
          return res.text().then(function (text) {
            var data = text ? JSON.parse(text) : null;
            if (!res.ok) throw new Error((data && (data.message || data.hint)) || ("HTTP " + res.status));
            return data;
          });
        });
      });
    }
  };

  // The deadline and the display status, as store.derived computes them on the PC.
  function addMonth(iso) {
    var parts = iso.split("-").map(Number);
    var year = parts[0] + (parts[1] === 12 ? 1 : 0);
    var month = parts[1] === 12 ? 1 : parts[1] + 1;
    var last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    var day = Math.min(parts[2], last);
    return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }
  function londonToday() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  }
  function derive(row) {
    var status = row.application_status || "saved";
    var applied = /^\d{4}-\d{2}-\d{2}$/.test(row.applied_at || "") ? row.applied_at : "";
    var deadline = (applied && status === "applied") ? addMonth(applied) : "";
    var display = status;
    if (deadline && !row.response_at && londonToday() > deadline) display = "presumed_unsuccessful";
    return { deadline: deadline, display_status: display };
  }

  function cloudRefresh() {
    clearTimeout(S.pollTimer);
    return SB.rest("opportunities?select=*&order=updated_at.desc").then(function (list) {
      var out = (list || []).map(function (row) {
        var extra = derive(row), copy = {}, key;
        for (key in row) { if (row.hasOwnProperty(key)) copy[key] = row[key]; }
        copy.deadline = extra.deadline;
        copy.display_status = extra.display_status;
        return copy;
      });
      S.data = { opportunities: out, tasks: [], kinds: (S.data && S.data.kinds) || {},
                 providers: (S.data && S.data.providers) || {},
                 generated_at: new Date().toISOString() };
      S.live = false; S.cloud = true; S.worker = "";
      showBanner("The worker on the PC is not running. You can read and change the "
                 + "tracker here. AI work and advert fetching need the PC.");
      setConnection(); render();
      S.pollTimer = setTimeout(cloudRefresh, 30000);
    }).catch(function (error) {
      S.cloud = false;
      goOffline("Cloud read failed: " + error.message);
    });
  }

  function cloudUpdate(id, changes) {
    var row = find(id);
    if (!row) return Promise.resolve();
    var body = {}, refused = [], key;
    for (key in changes) {
      if (!changes.hasOwnProperty(key)) continue;
      if (EDITABLE.indexOf(key) >= 0) body[key] = String(changes[key] == null ? "" : changes[key]);
      else refused.push(key);
    }
    if (refused.length) { alert("The worker on the PC sets " + refused.join(", ") + "."); }
    if (!Object.keys(body).length) return Promise.resolve();
    body.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
    // The row must still be the one this page read. If another device changed it,
    // no row matches, and the page reloads instead of overwriting that change.
    var query = "opportunities?opportunity_id=eq." + encodeURIComponent(id)
              + "&row_updated_at=eq." + encodeURIComponent(row.row_updated_at || "");
    return SB.rest(query, "PATCH", body, "return=representation").then(function (out) {
      if (!out || !out.length) {
        showBanner("This job changed on another device. Nothing was overwritten. "
                   + "The page is reloading it now.");
        return cloudRefresh();
      }
      if (document.activeElement) document.activeElement.blur();
      return cloudRefresh();
    }).catch(function (error) { alert("Save failed: " + error.message); });
  }

  // ------------------------------------------------------------ network ---
  function api(method, path, body, base) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller && setTimeout(function () { controller.abort(); }, method === "GET" ? 8000 : 30000);
    return fetch((base || S.worker) + path, {
      method: method, headers: { "Content-Type": "application/json", "X-Token": settings().token },
      body: body ? JSON.stringify(body) : undefined, signal: controller ? controller.signal : undefined,
      credentials: "omit"
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function candidates() {
    var list = [];
    var custom = settings().workerUrl.replace(/\/+$/, "");
    if (location.protocol.indexOf("http") === 0) list.push(location.origin);
    if (custom) list.push(custom);
    ((S.data && S.data.worker_urls) || []).forEach(function (u) { list.push(u); });
    return list.filter(function (u, i) { return u && list.indexOf(u) === i; });
  }

  function connect() {
    var list = candidates();
    if (!settings().token || !list.length) { fallback(settings().token ? "No worker address is known." : "No worker token is set."); return; }
    var i = 0;
    (function next() {
      if (i >= list.length) { fallback("The worker on the PC is not reachable."); return; }
      var base = list[i++];
      api("GET", "/api/health", null, base).then(function (h) {
        if (!h.authorised) { fallback("The worker rejected the token. Check it in Settings."); return; }
        S.worker = base; S.live = true; S.cloud = false; refresh();
      }).catch(next);
    })();
  }

  /// The worker is the first choice, because only it runs the AI work and holds the
  /// files. The Supabase account is the second, so the tracker still works away from
  /// home.
  function fallback(message) {
    if (SB.ready()) return cloudRefresh();
    goOffline(message + (SB.configured() ? " Sign in to use the tracker from here." : ""));
  }

  function goOffline(message) {
    S.live = false; S.cloud = false; S.worker = "";
    setConnection();
    showBanner(message);
    render();
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(connect, 30000);
  }

  function refresh() {
    clearTimeout(S.pollTimer);
    api("GET", "/api/state").then(function (data) {
      S.data = data; S.live = true;
      var git = data.git_sync;
      showBanner(git && git.ok === false ? git.message + " The worker tries again every 5 minutes." : "");
      setConnection(); render();
      var busy = (data.tasks || []).some(function (t) { return t.status === "running" || t.status === "queued"; }) ||
        rows().some(function (r) { return r.research_status === "fetching" || r.research_status === "pending"; });
      S.pollTimer = setTimeout(refresh, busy ? 2500 : 10000);
    }).catch(function () { connect(); });
  }

  function setConnection() {
    var el = $("connection");
    if (S.live) {
      el.className = "pill pill-good";
      el.textContent = "Live · " + S.worker.replace(/^https?:\/\//, "");
    } else if (S.cloud) {
      el.className = "pill pill-accent";
      el.textContent = "Cloud · " + (SB.email() || "signed in");
    } else {
      el.className = "pill pill-warn";
      el.textContent = "Not connected";
    }
    $("addButton").disabled = !(S.live || S.cloud);
    var signIn = $("signInButton");
    if (signIn) {
      signIn.hidden = !SB.configured();
      signIn.textContent = SB.ready() ? "Account" : "Sign in";
    }
  }

  function showBanner(text) {
    var b = $("banner");
    b.hidden = !text; b.textContent = text || "";
  }

  // ------------------------------------------------------------- render ---
  function visible() {
    var tab = TABS.filter(function (t) { return t[0] === S.tab; })[0];
    var q = S.q.toLowerCase();
    return rows().filter(function (r) {
      if (r.archived === "true" && S.tab !== "all") return false;
      var status = r.display_status || r.application_status;
      if (tab[2] && tab[2].indexOf(status) < 0) return false;
      if (!q) return true;
      return [r.employer_name, r.job_title, r.notes, r.location, r.package_summary].join(" ").toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }

  function render() {
    renderMetrics(); renderTabs(); renderRows(); renderDrawer();
    $("footnote").textContent = S.data
      ? "Loaded " + fmtTime(S.data.generated_at) + ". No-response deadline: one calendar month after submission, unless the employer replies. Adverts of active jobs are checked once a day on the employer site and LinkedIn."
      : "";
  }

  function renderMetrics() {
    var all = rows().filter(function (r) { return r.archived !== "true"; });
    function count(fn) { return all.filter(fn).length; }
    var soon = count(function (r) { var d = daysUntil(r.deadline); return r.display_status === "applied" && d !== null && d >= 0 && d <= 7; });
    var items = [
      [count(function (r) { return r.application_status === "saved" || r.application_status === "ready"; }), "To prepare or submit"],
      [count(function (r) { return r.display_status === "applied"; }), "Applied, awaiting reply"],
      [count(function (r) { return r.application_status === "interviewing" || r.application_status === "offer"; }), "In interview process"],
      [soon, "Deadlines in the next 7 days"],
      [count(function (r) { return r.display_status === "presumed_unsuccessful"; }), "Presumed unsuccessful"]
    ];
    $("metrics").innerHTML = items.map(function (m) { return '<div class="metric"><b>' + m[0] + "</b><span>" + esc(m[1]) + "</span></div>"; }).join("");
  }

  function renderTabs() {
    $("tabs").innerHTML = TABS.map(function (t) {
      var n = rows().filter(function (r) {
        var s = r.display_status || r.application_status;
        return (r.archived !== "true" || t[0] === "all") && (!t[2] || t[2].indexOf(s) >= 0);
      }).length;
      return '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + esc(t[1]) + "<small>" + n + "</small></button>";
    }).join("");
  }

  function renderRows() {
    var list = visible();
    $("empty").hidden = list.length > 0;
    $("rows").innerHTML = list.map(function (r) {
      var d = daysUntil(r.deadline);
      var deadline = r.deadline ? fmtDate(r.deadline) + (d !== null && r.display_status === "applied" ? ' <span class="muted">(' + (d >= 0 ? d + " days" : "passed") + ")</span>" : "") : '<span class="muted">—</span>';
      var research = r.research_status === "fetching" || r.research_status === "pending" ? " " + pill("Fetching advert", "accent") : r.research_status === "failed" ? " " + pill("Advert not fetched", "warn") : "";
      var cvHref = S.live && r.cv_pdf ? fileUrl("tex/" + encodeURIComponent(r.cv_pdf)) : "";
      var cv = r.cv_pdf ? (cvHref ? '<a href="' + esc(cvHref) + '" target="_blank" rel="noopener" data-stop>PDF</a>' : "Yes") : '<span class="muted">—</span>';
      var sub = [r.location, r.package_summary].filter(Boolean).join(" · ");
      return '<tr data-id="' + esc(r.opportunity_id) + '"' + (S.selected === r.opportunity_id ? ' class="selected"' : "") + ">" +
        '<td><div class="role-title">' + esc(r.employer_name || "Unknown employer") + " · " + esc(r.job_title || "Untitled role") + research + "</div>" +
        (sub ? '<div class="role-sub">' + esc(sub) + "</div>" : "") + "</td>" +
        "<td>" + statusPill(r) + "</td><td>" + verdictPill(r.verdict) + "</td>" +
        "<td>" + (r.applied_at ? fmtDate(r.applied_at) : '<span class="muted">—</span>') + "</td>" +
        "<td>" + deadline + "</td><td>" + postingPill(r) + "</td><td>" + cv + "</td>" +
        '<td class="muted">' + esc(fmtDate(r.updated_at)) + "</td></tr>";
    }).join("");
  }

  function providerOptions(selected) {
    var p = (S.data && S.data.providers) || {};
    return ["claude", "codex", "ollama"].map(function (key) {
      var info = p[key] || {};
      var label = (info.label || key) + (info.available === false ? " (unavailable)" : "");
      return '<option value="' + key + '"' + (key === selected ? " selected" : "") + (info.available === false ? " disabled" : "") + ">" + esc(label) + "</option>";
    }).join("");
  }

  function ollamaOptions(selected) {
    var models = (((S.data || {}).providers || {}).ollama || {}).models || [];
    if (!models.length) return '<option value="">No local models found</option>';
    return models.map(function (m) { return '<option' + (m === selected ? " selected" : "") + ">" + esc(m) + "</option>"; }).join("");
  }

  function renderDrawer() {
    var drawer = $("drawer");
    var row = S.selected && find(S.selected);
    drawer.classList.toggle("open", !!row);
    drawer.setAttribute("aria-hidden", row ? "false" : "true");
    $("scrim").hidden = !row;
    if (!row) return;
    var active = document.activeElement;
    if (active && drawer.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return; // do not wipe typing
    var live = S.live, dis = (live || S.cloud) ? "" : " disabled";
    // The cloud can change a field. Fetching an advert, an AI task and a task log all
    // run on the PC, so they stay off until the worker answers.
    var wdis = live ? "" : " disabled";
    var set = settings();
    var tasks = ((S.data && S.data.tasks) || []).filter(function (t) { return t.opportunity_id === row.opportunity_id; });
    var advert = row.employer_url || row.discovery_url;
    var cvHref = row.cv_pdf && live ? fileUrl("tex/" + encodeURIComponent(row.cv_pdf)) : "";
    var html = [];
    html.push('<div class="drawer-head"><div><h2>' + esc(row.job_title || "Untitled role") + '</h2><div class="muted">' + esc(row.employer_name) + "</div></div>" +
      '<button class="btn" type="button" data-action="close">Close</button></div>');
    html.push('<div class="links">' + statusPill(row) + " " + verdictPill(row.verdict) +
      (advert ? ' <a href="' + esc(advert) + '" target="_blank" rel="noopener noreferrer">Advert</a>' : "") +
      (row.application_url ? ' <a href="' + esc(row.application_url) + '" target="_blank" rel="noopener noreferrer">Apply</a>' : "") +
      (cvHref ? ' <a href="' + esc(cvHref) + '" target="_blank" rel="noopener">CV PDF</a>' : "") + "</div>");
    html.push(renderWarnings(row));
    html.push(renderFit(row));

    html.push("<h3>Details</h3><dl class=\"facts\">" +
      fact("Location", [row.location, row.working_pattern].filter(Boolean).join(" · ")) +
      fact("Package", row.package_summary) + fact("Posted", fmtDate(row.date_posted)) +
      fact("Closing date", fmtDate(row.closing_date)) + fact("Folder", row.application_folder ? "applications/" + row.application_folder : "") +
      fact("Submitted CV", row.submitted_version ? "tex/" + row.submitted_version : "") +
      fact("Captured", fmtTime(row.datetime_captured)) + "</dl>");
    if (row.research_status === "failed") {
      html.push('<p class="error-text">' + esc(row.last_error) + "</p>");
    }

    html.push("<h3>Tracking</h3><div class=\"box\"><div class=\"row\">" +
      '<label>Status<select id="fStatus"' + dis + ">" + (S.data.statuses || []).map(function (s) {
        return '<option value="' + s + '"' + (s === row.application_status ? " selected" : "") + ">" + esc(STATUS_LABELS[s] || s) + "</option>";
      }).join("") + "</select></label>" +
      '<label>Submitted<input id="fApplied" type="date" value="' + esc(row.applied_at) + '"' + dis + "></label>" +
      '<label>Employer replied<input id="fResponse" type="date" value="' + esc(row.response_at) + '"' + dis + "></label></div>" +
      '<div class="row" style="margin-top:8px"><label>Interview (date, time, who)<input id="fInterview" value="' + esc(row.interview_at) + '"' + dis + "></label>" +
      '<label>Closing date<input id="fClosing" type="date" value="' + esc(row.closing_date) + '"' + dis + "></label></div>" +
      '<label style="margin-top:8px">Notes<textarea id="fNotes" rows="3"' + dis + ">" + esc(row.notes) + "</textarea></label>" +
      '<div class="row" style="margin-top:10px"><button class="btn btn-primary" type="button" data-action="save"' + dis + ">Save</button>" +
      '<button class="btn" type="button" data-action="applied-today"' + dis + ">Mark applied today</button>" +
      '<button class="btn" type="button" data-action="archive"' + dis + ">" + (row.archived === "true" ? "Unarchive" : "Archive") + "</button></div>" +
      (row.deadline ? '<p class="muted" style="margin:8px 0 0">No-response deadline: ' + esc(fmtDate(row.deadline)) + ". A reply by the employer stops this rule.</p>" : "") +
      "</div>");

    html.push("<h3>AI work</h3><div class=\"box\"><div class=\"row\">" +
      '<label>Provider<select id="fProvider"' + wdis + ">" + providerOptions(set.provider) + "</select></label>" +
      '<label id="modelWrap">Model<span id="modelSlot"></span></label></div>' +
      '<label style="margin-top:8px">Extra instruction (optional, required for Custom)<textarea id="fInstruction" rows="2" placeholder="For example: stress the NetSuite work"' + wdis + "></textarea></label>" +
      '<div class="actions-grid">' + TASK_ORDER.concat(["custom"]).map(function (k) {
        return '<button class="btn" type="button" data-task="' + k + '"' + wdis + ">" + esc((S.data.kinds || {})[k] || k) + "</button>";
      }).join("") + "</div>" +
      '<p class="muted" style="margin:8px 0 0">Claude and ChatGPT use the subscriptions logged in on the PC and send the profile and advert to that service. Local runs stay on the PC.</p></div>');

    html.push("<h3>Tasks</h3>" + (tasks.length ? "<div>" + tasks.map(function (t) {
      var tone = { done: "good", failed: "bad", running: "accent", queued: "muted", interrupted: "warn", cancelled: "muted", incomplete: "warn" }[t.status];
      var checkName = t.kind === "questions" ? "Quality check" : "Claims check";
      var check = t.check ? " " + pill(checkName + (t.check.ok ? " passed" : " failed"), t.check.ok ? "good" : "bad") : "";
      return '<div class="task"><div><b>' + esc(t.label) + "</b> " + pill(t.status, tone) + check + '<div class="task-meta">' +
        esc(((S.data.providers || {})[t.provider] || {}).label || t.provider) + (t.model ? " · " + esc(t.model) : "") + " · " + esc(fmtTime(t.created)) + "</div></div>" +
        '<button class="btn btn-small" type="button" data-log="' + esc(t.id) + '"' + wdis + ">Log</button></div>";
    }).join("") + "</div>" : '<p class="muted">No AI tasks yet.</p>'));

    html.push(renderPosting(row, live, wdis));

    html.push("<h3>Advert</h3><div class=\"box\">" +
      '<label>Advert link<input id="fUrl" type="url" value="' + esc(advert) + '"' + wdis + "></label>" +
      '<label style="margin-top:8px">Or paste the advert text<textarea id="fAdText" rows="3"' + wdis + "></textarea></label>" +
      '<div class="row" style="margin-top:8px"><button class="btn" type="button" data-action="refetch"' + wdis + ">Fetch or save advert</button>" +
      '<span class="muted">Research: ' + esc(row.research_status || "—") + "</span></div></div>");

    html.push('<h3>Files</h3><div id="fileList">' + (live ? (S.files[row.opportunity_id] || '<p class="muted">Loading…</p>') : '<p class="muted">The worker on the PC lists the files. Away from home, the Notes below open them.</p>') + "</div>");
    html.push("<h3>Notes</h3>" + (SB.ready()
      ? '<div id="noteList">' + (S.notes[row.opportunity_id] || '<p class="muted">Loading…</p>') + "</div>"
      : '<p class="muted">Sign in to read and change the notes from any device.</p>'));
    $("drawerBody").innerHTML = html.join("");
    renderModelSlot();
    if (live) loadFiles(row.opportunity_id);
    if (SB.ready()) loadNotes(row);
  }

  // Fit verdict, reasons, gaps and partial matches, read by the worker from the application notes.
  function renderFit(row) {
    var fit = row.fit || {};
    var summary = fit.summary || row.fit_summary;
    var gaps = fit.gaps || [], weak = fit.weak || [];
    if (!row.verdict && !summary && !gaps.length && !weak.length) {
      return '<h3>Fit</h3><p class="muted">No fit assessment yet. Run Assess fit under AI work.</p>';
    }
    var html = ['<h3>Fit</h3><div class="box fit">'];
    html.push('<div class="fit-head">' + verdictPill(row.verdict) + (fit.scores ? ' <span class="muted">' + esc(fit.scores) + "</span>" : "") + "</div>");
    if (summary) html.push('<p class="fit-summary">' + esc(summary) + "</p>");
    if (gaps.length) {
      html.push('<h4>Gaps</h4><ul class="fit-list">' + gaps.map(function (g) { return "<li>" + esc(g) + "</li>"; }).join("") + "</ul>");
    }
    if (weak.length) {
      html.push('<h4>Partial or missing matches</h4><ul class="fit-list">' + weak.map(function (w) {
        return "<li>" + pill(w.match === "NONE" ? "None" : "Partial", w.match === "NONE" ? "bad" : "warn") + " <b>" + esc(w.requirement) + "</b>" +
          (w.evidence ? '<span class="muted"> · ' + esc(w.evidence) + "</span>" : "") + "</li>";
      }).join("") + "</ul>");
    }
    if (fit.source) html.push('<p class="muted fit-source">From ' + esc(fit.source) + "</p>");
    html.push("</div>");
    return html.join("");
  }

  // Notes in the folder that contradict the tracker values.
  function renderWarnings(row) {
    var list = row.warnings || [];
    if (!list.length) return "";
    return '<h3>Details to correct</h3><div class="box warn-box"><p class="muted" style="margin:0 0 6px">These lines contradict the tracker. The tracker values are correct.</p><ul class="fit-list">' +
      list.map(function (w) {
        return "<li><b>" + esc(w.file) + " line " + esc(w.line) + "</b> " + esc(w.problem) + '<div class="muted">' + esc(w.text) + "</div></li>";
      }).join("") + "</ul></div>";
  }

  // Advert copies and the daily check on the employer site and LinkedIn.
  function renderPosting(row, live, dis) {
    var last = row.posting || {}, official = last.official || {}, linkedin = last.linkedin || {};
    var files = row.advert_files || [];
    var html = ['<h3>Advert check</h3><div class="box">'];
    if (row.posting_status) {
      html.push('<div class="fit-head">' + postingPill(row) + ' <span class="muted">Checked ' + esc(fmtTime(row.posting_checked_at)) + "</span></div>");
      html.push('<p class="fit-summary">' + esc(row.posting_summary) + "</p>");
    } else {
      html.push('<p class="muted" style="margin-top:0">Not checked yet. The worker checks active jobs once a day.</p>');
    }
    var links = [];
    // The check details come from the worker. Away from home only the tracker row is
    // there, so fall back to its advert link and LinkedIn listing.
    var advertUrl = official.url || row.employer_url || row.discovery_url;
    if (advertUrl) links.push('<a href="' + esc(advertUrl) + '" target="_blank" rel="noopener noreferrer">Advert</a>' + (official.published ? ' <span class="muted">published ' + esc(fmtDate(official.published)) + "</span>" : ""));
    if (!(linkedin.jobs || []).length && row.linkedin_url && row.linkedin_url !== advertUrl) {
      links.push('<a href="' + esc(row.linkedin_url) + '" target="_blank" rel="noopener noreferrer">LinkedIn listing</a>');
    }
    (linkedin.jobs || []).forEach(function (j) {
      var extra = [j.age || (j.posted ? "posted " + fmtDate(j.posted) : ""), j.applicants, j.closed ? "closed" : ""].filter(Boolean).join(" · ");
      links.push('<a href="' + esc(j.url) + '" target="_blank" rel="noopener noreferrer">LinkedIn: ' + esc(j.title) + "</a>" + (extra ? ' <span class="muted">' + esc(extra) + "</span>" : ""));
    });
    if (linkedin.search) links.push('<a href="' + esc(linkedin.search) + '" target="_blank" rel="noopener noreferrer">Search LinkedIn</a>');
    if (links.length) html.push('<ul class="fit-list">' + links.map(function (l) { return "<li>" + l + "</li>"; }).join("") + "</ul>");
    var copies = files.map(function (name) {
      var label = name === "job-ad-applied.md" ? "Copy from the application" : name === "job-ad.md" ? "First capture" : name;
      var href = folderFile(row, name);
      return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + "</a>" : esc(label);
    });
    html.push('<p class="muted" style="margin:8px 0 0">Saved adverts: ' + (copies.length ? copies.join(" · ")
      : live ? "none" : "open job-ad.md or job-ad-applied.md under Notes") + "</p>");
    html.push('<div class="row" style="margin-top:8px"><button class="btn" type="button" data-action="check-posting"' + (live ? "" : " disabled") + ">Check now</button></div></div>");
    return html.join("");
  }


  function fact(label, value) { return value ? "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>" : ""; }

  function renderModelSlot() {
    var provider = $("fProvider");
    if (!provider) return;
    var set = settings(), slot = $("modelSlot");
    if (provider.value === "ollama") {
      slot.outerHTML = '<select id="modelSlot"' + (S.live ? "" : " disabled") + ">" + ollamaOptions(set.ollamaModel) + "</select>";
    } else {
      var value = provider.value === "claude" ? set.claudeModel : set.codexModel;
      slot.outerHTML = '<input id="modelSlot" placeholder="CLI default" value="' + esc(value) + '"' + (S.live ? "" : " disabled") + ">";
    }
  }

  function loadFiles(id) {
    api("GET", "/api/opportunities/" + encodeURIComponent(id) + "/files").then(function (data) {
      var el = $("fileList");
      if (!el || S.selected !== id) return;
      el.innerHTML = S.files[id] = data.files.length ? '<ul class="files">' + data.files.map(function (f) {
        return '<li><a href="' + esc(fileUrl(f.href)) + '" target="_blank" rel="noopener">' + esc(f.name) + "</a><span>" + esc(fmtTime(new Date(f.modified * 1000).toISOString())) + "</span></li>";
      }).join("") + "</ul>" : '<p class="muted">No files yet.</p>';
    }).catch(function (e) { var el = $("fileList"); if (el) el.innerHTML = '<p class="error-text">' + esc(e.message) + "</p>"; });
  }

  // -------------------------------------------------------------- notes ---
  // The notes live in Supabase. A sync agent on a computer takes each change to the
  // repository, and it never merges: a change on both sides raises a conflict flag.
  var SHARED_DOCS = ["MASTER_PROFILE.md", "applications/INTERVIEW_PREP_PLAYBOOK.md"];
  var TRACKER = /<!-- tracker:start -->[\s\S]*?<!-- tracker:end -->/;
  var DOC = { path: "", row: null, readOnly: false, editing: false };

  function who(name) { return name === "page" ? "this page" : (name || "the computer").replace(/\.local$/, ""); }

  function loadNotes(row) {
    var id = row.opportunity_id, folder = row.application_folder;
    var query = folder
      ? SB.rest("documents?select=path,updated_at,conflict&order=path&path=like."
                + encodeURIComponent("applications/" + folder + "/*"))
      : Promise.resolve([]);
    query.then(function (docs) {
      var el = $("noteList");
      if (!el || S.selected !== id) return;
      var base = "applications/" + folder + "/";
      var items = (docs || []).map(function (d) {
        return '<li><button type="button" data-doc="' + esc(d.path) + '">' + esc(d.path.slice(base.length)) + "</button>" +
          (d.conflict ? pill("Conflict", "bad") : "<span>" + esc(fmtTime(d.updated_at)) + "</span>") + "</li>";
      });
      // The CV sent, then the current CV when it differs.
      var cvs = ["submitted_version", "cv_pdf"].filter(function (k) {
        return row[k] && (k === "submitted_version" || row.cv_pdf !== row.submitted_version);
      }).map(function (k) {
        return '<li><button type="button" data-pdf="tex/' + esc(row[k]) + '">' + esc(row[k]) + "</button><span>" +
          (k === "submitted_version" ? "CV sent" : "CV") + "</span></li>";
      });
      var shared = SHARED_DOCS.map(function (path) {
        return '<li><button type="button" data-doc="' + esc(path) + '" data-readonly>' + esc(path.split("/").pop()) + "</button><span>read only</span></li>";
      });
      el.innerHTML = S.notes[id] =
        (items.length ? '<ul class="notes">' + items.join("") + "</ul>" : '<p class="muted">No notes for this job yet.</p>') +
        '<form class="new-note" data-newnote><input name="note" placeholder="New note name, for example interview-record-20261005" autocomplete="off" required>' +
        '<button class="btn" type="submit">New note</button></form>' +
        (cvs.length ? '<ul class="notes" style="margin-top:10px">' + cvs.join("") + "</ul>" : "") +
        '<ul class="notes" style="margin-top:10px">' + shared.join("") + "</ul>";
    }).catch(function (e) { var el = $("noteList"); if (el) el.innerHTML = '<p class="error-text">' + esc(e.message) + "</p>"; });
  }

  // ------------------------------------------- cloud: new jobs and new notes ---
  // The folder rule of store.ensure_folder, so a job added here gets the folder the
  // worker would give it. The sync agent on the PC or the MacBook writes the notes of a
  // new folder to its disk, and git takes them to the other machine.
  function slugify(text) {
    var s = String(text || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 60).replace(/^-+|-+$/g, "") || "role";
  }
  function folderFor(employer, title) {
    var base = (slugify(employer || "employer") + "-" + slugify(title || "role")).slice(0, 80).replace(/^-+|-+$/g, "")
             + "-" + londonToday().replace(/-/g, "");
    var taken = rows().map(function (r) { return r.application_folder; });
    var name = base, n = 2;
    while (taken.indexOf(name) >= 0) { name = base + "-" + n; n += 1; }
    return name;
  }
  function newId() {
    var bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function nowUtc() { return new Date().toISOString().replace(/\.\d+Z$/, "+00:00"); }
  function londonStamp() {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit",
      hour12: false, timeZoneName: "short" }).formatToParts(new Date());
    var get = function (t) { return (parts.filter(function (p) { return p.type === t; })[0] || {}).value || ""; };
    return londonToday() + " " + get("hour") + ":" + get("minute") + " " + get("timeZoneName");
  }
  function sameUrl(a, b) {
    var key = function (u) { return String(u || "").split("?")[0].replace(/\/+$/, "").toLowerCase(); };
    return !!key(a) && key(a) === key(b);
  }
  // The duplicate test of store.find_duplicate: the same advert link, or the same
  // employer and job title.
  function duplicateOf(body) {
    var low = function (s) { return String(s || "").toLowerCase(); };
    return rows().filter(function (r) {
      return (body.url && (sameUrl(r.discovery_url, body.url) || sameUrl(r.employer_url, body.url))) ||
        (body.employer_name && body.job_title && low(r.employer_name) === low(body.employer_name) &&
         low(r.job_title) === low(body.job_title));
    })[0] || null;
  }
  function statusNote(id, employer, title) {
    return "# Application status\n\n- Employer: " + employer + "\n- Role: " + title + "\n- Workbench ID: " + id
      + "\n- Captured: " + londonToday() + "\n\nThe workbench appends dated status changes below. "
      + "See the [tracking policy](../README.md).\n\n## Status history\n\n- " + londonStamp()
      + ": Added on the page, with no worker running. The PC fetches no advert until you ask it to.\n";
  }

  function cloudAdd(body) {
    if (!body.employer_name || !body.job_title) {
      return Promise.reject(new Error("With the PC off, give the employer and the job title. The page cannot fetch the advert."));
    }
    if (!body.allow_duplicate) {
      var dup = duplicateOf(body);
      if (dup) return Promise.resolve({ duplicate: dup });
    }
    var id = newId(), folder = folderFor(body.employer_name, body.job_title), stamp = nowUtc();
    var row = { opportunity_id: id, employer_name: body.employer_name, job_title: body.job_title,
      discovery_url: body.url, notes: body.notes, application_status: "saved", applied: "false",
      application_folder: folder, datetime_captured: stamp, updated_at: stamp };
    var base = "applications/" + folder + "/";
    var docs = [{ path: base + "status.md", body: statusNote(id, body.employer_name, body.job_title), updated_by: "page" }];
    if (body.text) {
      docs.push({ path: base + "job-ad.md", updated_by: "page",
        body: "# " + body.job_title + ": " + body.employer_name + "\n\nSource: " + (body.url || "pasted on the page")
          + "\nRetrieved: " + londonToday() + "\nMethod: pasted on the page\n\n" + body.text + "\n" });
    }
    return SB.rest("opportunities", "POST", row, "return=minimal").then(function () {
      return SB.rest("documents", "POST", docs, "return=minimal");
    }).then(function () { return { opportunity: row }; });
  }

  // Give a job without a folder its folder and status note. The filter on the empty
  // folder makes a second device that does the same find no row.
  function claimFolder(row) {
    var folder = folderFor(row.employer_name, row.job_title);
    var query = "opportunities?opportunity_id=eq." + encodeURIComponent(row.opportunity_id) + "&application_folder=eq.";
    return SB.rest(query, "PATCH", { application_folder: folder, updated_at: nowUtc() }, "return=representation")
      .then(function (out) {
        if (!out || !out.length) throw new Error("the job changed on another device. Reload the page and try again");
        row.application_folder = folder;
        return SB.rest("documents", "POST", [{ path: "applications/" + folder + "/status.md",
          body: statusNote(row.opportunity_id, row.employer_name, row.job_title), updated_by: "page" }], "return=minimal");
      }).then(function () { return folder; });
  }

  function createNote(row, name) {
    name = String(name || "").trim().toLowerCase().replace(/\.md$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      alert("Use lower-case letters, digits and hyphens, for example interview-record-20261005.");
      return;
    }
    var ready = row.application_folder ? Promise.resolve(row.application_folder) : claimFolder(row);
    ready.then(function (folder) {
      var path = "applications/" + folder + "/" + name + ".md";
      var heading = name.replace(/-/g, " ");
      return SB.rest("documents", "POST", [{ path: path, updated_by: "page",
        body: "# " + heading.charAt(0).toUpperCase() + heading.slice(1) + "\n\n" }], "return=minimal")
        .then(function () { refreshNotes(); openDoc(path, false); });
    }).catch(function (e) {
      alert(/duplicate|already exists|409/i.test(e.message) ? "A note with that name exists already."
        : "The note was not created: " + e.message);
    });
  }

  function openPdf(name) {
    // Open the window now: a browser blocks a window that opens after a network call.
    var win = window.open("", "_blank");
    var c = SB.conf();
    SB.token().then(function (tok) {
      return fetch(c.url + "/storage/v1/object/sign/application-files/" + name.split("/").map(encodeURIComponent).join("/"), {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", apikey: c.key, Authorization: "Bearer " + tok },
        body: JSON.stringify({ expiresIn: 300 })
      });
    }).then(function (res) { return res.json(); }).then(function (d) {
      if (!d.signedURL) throw new Error(d.message || d.error || "no link came back");
      var url = c.url + "/storage/v1" + d.signedURL;
      if (win) win.location = url; else location.href = url;
    }).catch(function (e) { if (win) win.close(); alert("Cannot open the PDF: " + e.message); });
  }

  function openDoc(path, readOnly) {
    DOC = { path: path, row: null, readOnly: !!readOnly, editing: false };
    $("docTitle").textContent = path.split("/").pop();
    $("docLine").value = "";
    showDoc();
    $("docDialog").showModal();
    reloadDoc();
  }

  function reloadDoc() {
    return SB.rest("documents?select=path,body,updated_at,updated_by,conflict&path=eq." + encodeURIComponent(DOC.path))
      .then(function (found) {
        DOC.row = (found && found[0]) || null;
        if (!DOC.row) { $("docMeta").textContent = "This note is not in the cloud yet. The sync agent adds it."; return; }
        showDoc();
      }).catch(function (e) { $("docMeta").textContent = "Cannot load the note: " + e.message; });
  }

  function showDoc() {
    var r = DOC.row, editable = !!r && !DOC.readOnly && !r.conflict;
    $("docMeta").textContent = r ? DOC.path + " · changed " + fmtTime(r.updated_at) + " by " + who(r.updated_by)
                                     + (DOC.readOnly ? " · read only here" : "") : "Loading…";
    $("docBanner").hidden = !(r && r.conflict);
    $("docBanner").textContent = "This note changed here and on a computer at the same time. The computer kept "
      + "both versions. Merge them there and run docsync resolve. Then you can change it here again.";
    $("docView").hidden = DOC.editing;
    $("docText").hidden = !DOC.editing;
    $("docEditActions").hidden = !DOC.editing;
    $("docEdit").hidden = !editable || DOC.editing;
    $("docAppend").hidden = !editable || DOC.editing;
    if (!DOC.editing) $("docView").innerHTML = r ? window.renderMarkdown(r.body) : "";
  }

  function dirty() { return DOC.editing && DOC.row && $("docText").value !== DOC.row.body; }

  function closeDoc(event) {
    if (dirty() && !confirm("Discard your changes to this note?")) {
      if (event) event.preventDefault();
      return;
    }
    DOC.editing = false;
    $("docDialog").close();
  }

  function saveDoc() {
    var text = $("docText").value, old = DOC.row.body;
    var block = (old.match(TRACKER) || [""])[0];
    if (block && text.indexOf(block) < 0) {
      alert("The tracker section between the tracker:start and tracker:end lines comes from the job page. "
            + "Put it back as it was, or press Cancel. Change those values on the job page instead.");
      return;
    }
    if (text === old) { DOC.editing = false; showDoc(); return; }
    // The note must still be the version this page read. If a computer or another
    // device changed it, no row matches, the save does nothing, and the text stays.
    var query = "documents?path=eq." + encodeURIComponent(DOC.path)
              + "&updated_at=eq." + encodeURIComponent(DOC.row.updated_at) + "&conflict=eq.false";
    $("docSave").disabled = true;
    SB.rest(query, "PATCH", { body: text, updated_by: "page" }, "return=representation").then(function (out) {
      if (!out || !out.length) {
        alert("This note changed somewhere else after you opened it. Nothing was saved, and your text "
              + "is still in the box. Copy it, press Cancel to see the new version, then add your change again.");
        return;
      }
      DOC.row = out[0]; DOC.editing = false; showDoc(); refreshNotes();
    }).catch(function (e) { alert("Save failed: " + e.message); })
      .then(function () { $("docSave").disabled = false; });
  }

  function appendLine(event) {
    event.preventDefault();
    var line = $("docLine").value.replace(/\s+/g, " ").trim();
    if (!line) return;
    SB.rest("rpc/append_note", "POST", { doc_path: DOC.path, line: line }).then(function (out) {
      if (!out || !out.length) {
        alert("The line was not added: this note is under a conflict. Settle it on a computer first.");
        return reloadDoc();
      }
      DOC.row = out[0]; $("docLine").value = ""; showDoc(); refreshNotes();
      var view = $("docView"); view.scrollTop = view.scrollHeight;
    }).catch(function (e) { alert("The line was not added: " + e.message); });
  }

  function refreshNotes() { var row = find(S.selected); if (row) loadNotes(row); }

  // ------------------------------------------------------------ actions ---
  function update(id, changes) {
    if (S.cloud && !S.live) return cloudUpdate(id, changes);
    return api("POST", "/api/opportunities/" + encodeURIComponent(id), changes).then(function () {
      if (document.activeElement) document.activeElement.blur();
      refresh();
    }).catch(function (e) { alert("Save failed: " + e.message); });
  }

  function onDrawerClick(event) {
    var target = event.target.closest("button");
    if (!target) return;
    if (target.hasAttribute("data-doc")) {
      openDoc(target.getAttribute("data-doc"), target.hasAttribute("data-readonly"));
      return;
    }
    if (target.hasAttribute("data-pdf")) { openPdf(target.getAttribute("data-pdf")); return; }
    var row = find(S.selected);
    if (!row) return;
    var action = target.getAttribute("data-action");
    if (action === "close") { S.selected = null; render(); return; }
    if (action === "save") {
      update(row.opportunity_id, {
        application_status: $("fStatus").value, applied_at: $("fApplied").value, response_at: $("fResponse").value,
        interview_at: $("fInterview").value, closing_date: $("fClosing").value, notes: $("fNotes").value
      });
    }
    if (action === "applied-today") {
      update(row.opportunity_id, { application_status: "applied", applied_at: (S.data.today || new Date().toISOString().slice(0, 10)) });
    }
    if (action === "check-posting") {
      target.disabled = true;
      api("POST", "/api/opportunities/" + encodeURIComponent(row.opportunity_id) + "/check-posting", {})
        .then(function () { setTimeout(refresh, 4000); setTimeout(refresh, 15000); })
        .catch(function (e) { target.disabled = false; alert(e.message); });
    }
    if (action === "archive") update(row.opportunity_id, { archived: row.archived === "true" ? "" : "true" });
    if (action === "refetch") {
      api("POST", "/api/opportunities/" + encodeURIComponent(row.opportunity_id) + "/fetch", { url: $("fUrl").value, text: $("fAdText").value })
        .then(function () { $("fAdText").value = ""; document.activeElement.blur(); refresh(); })
        .catch(function (e) { alert(e.message); });
    }
    var kind = target.getAttribute("data-task");
    if (kind) {
      var provider = $("fProvider").value, model = ($("modelSlot").value || "").trim();
      store("provider", provider);
      if (provider === "ollama") store("ollamaModel", model);
      target.disabled = true;
      api("POST", "/api/tasks", { opportunity_id: row.opportunity_id, kind: kind, provider: provider, model: model, instruction: $("fInstruction").value })
        .then(function (res) { $("fInstruction").value = ""; document.activeElement.blur(); refresh(); openLog(res.task.id); })
        .catch(function (e) { target.disabled = false; alert(e.message); });
    }
    var log = target.getAttribute("data-log");
    if (log) openLog(log);
  }

  function openLog(id) {
    S.logTask = id; S.logOffset = 0;
    $("logText").textContent = ""; $("logSummary").textContent = "";
    $("logDialog").showModal();
    pollLog();
  }

  function pollLog() {
    clearTimeout(S.logTimer);
    if (!S.logTask || !$("logDialog").open) return;
    api("GET", "/api/tasks/" + encodeURIComponent(S.logTask) + "/log?offset=" + S.logOffset).then(function (data) {
      var pre = $("logText"), atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      if (data.text) { pre.textContent += data.text; if (atEnd) pre.scrollTop = pre.scrollHeight; }
      S.logOffset = data.offset;
      var t = data.task || {};
      $("logTitle").textContent = (t.label || "Task") + " · " + (t.status || "");
      $("logSummary").textContent = t.summary || "";
      $("logCancel").hidden = !(t.status === "running" || t.status === "queued");
      if (t.status === "running" || t.status === "queued") S.logTimer = setTimeout(pollLog, 1500);
    }).catch(function () { S.logTimer = setTimeout(pollLog, 4000); });
  }

  function onAdd(event) {
    event.preventDefault();
    var form = $("addForm"), msg = $("addMessage"), body = {};
    ["url", "employer_name", "job_title", "text", "notes"].forEach(function (k) { body[k] = form.elements[k].value.trim(); });
    if (form.dataset.allowDuplicate === "1") body.allow_duplicate = true;
    msg.hidden = true; $("addSubmit").disabled = true;
    var cloud = S.cloud && !S.live;   // the PC is off: save the job straight to Supabase
    (cloud ? cloudAdd(body) : api("POST", "/api/opportunities", body)).then(function (res) {
      $("addSubmit").disabled = false;
      if (res.duplicate) {
        msg.hidden = false;
        msg.textContent = "This looks like an existing entry: " + res.duplicate.employer_name + " · " + res.duplicate.job_title + ". Click Go again to add it anyway.";
        form.dataset.allowDuplicate = "1";
        return;
      }
      form.reset(); delete form.dataset.allowDuplicate;
      $("addDialog").close();
      S.selected = res.opportunity.opportunity_id; S.tab = "active";
      if (cloud) cloudRefresh(); else refresh();
    }).catch(function (e) { $("addSubmit").disabled = false; msg.hidden = false; msg.textContent = e.message; });
  }

  function openSettings() {
    var f = $("settingsForm"), s = settings();
    ["token", "workerUrl", "claudeModel", "codexModel"].forEach(function (k) { f.elements[k].value = s[k]; });
    f.elements.provider.value = s.provider;
    f.elements.ollamaModel.innerHTML = ollamaOptions(s.ollamaModel);
    $("settingsMessage").hidden = true;
    $("settingsDialog").showModal();
  }

  function onSettings(event) {
    event.preventDefault();
    var f = $("settingsForm");
    ["token", "workerUrl", "provider", "ollamaModel", "claudeModel", "codexModel"].forEach(function (k) { store(k, f.elements[k].value.trim()); });
    $("settingsDialog").close();
    connect();
  }

  // --------------------------------------------------------------- boot ---
  function boot() {
    var hash = location.hash.match(/token=([^&]+)/);
    if (hash) { store("token", decodeURIComponent(hash[1])); history.replaceState(null, "", location.pathname); }
    $("tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-tab]"); if (!b) return;
      S.tab = b.getAttribute("data-tab"); render();
    });
    $("search").addEventListener("input", function (e) { S.q = e.target.value; renderRows(); });
    $("rows").addEventListener("click", function (e) {
      if (e.target.closest("[data-stop]")) return;
      var tr = e.target.closest("tr[data-id]"); if (!tr) return;
      S.selected = tr.getAttribute("data-id"); render();
    });
    $("drawerBody").addEventListener("click", onDrawerClick);
    $("drawerBody").addEventListener("submit", function (e) {
      var form = e.target.closest("[data-newnote]");
      if (!form) return;
      e.preventDefault();
      var row = find(S.selected);
      if (row) createNote(row, form.elements.note.value);
    });
    $("drawerBody").addEventListener("change", function (e) { if (e.target.id === "fProvider") renderModelSlot(); });
    $("scrim").addEventListener("click", function () { S.selected = null; render(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.selected && !document.querySelector("dialog[open]")) { S.selected = null; render(); } });
    $("addButton").addEventListener("click", function () { $("addMessage").hidden = true; $("addDialog").showModal(); });
    $("settingsButton").addEventListener("click", openSettings);
    $("signInButton").addEventListener("click", function () {
      var form = $("signInForm");
      form.elements.email.value = SB.email();
      form.elements.password.value = "";
      form.elements.code.value = "";
      $("signInMessage").hidden = true;
      $("signOutButton").hidden = !SB.session();
      codeStep(SB.needsCode());
      showFactorState();
      $("signInDialog").showModal();
    });
    $("signInForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var form = event.target, message = $("signInMessage");
      var button = form.querySelector('button[type="submit"]');
      var withCode = !$("signInCodeRow").hidden;
      message.hidden = true; button.disabled = true; button.textContent = "Signing in…";
      var work = withCode
        ? SB.verifyCode(SB.factor().id, form.elements.code.value.trim())
        : SB.signIn(form.elements.email.value.trim(), form.elements.password.value);
      work.then(function () {
          if (SB.needsCode()) {   // the password was right; the account asks for the code
            codeStep(true);
            message.hidden = false;
            message.textContent = "Enter the 6-digit code from your authenticator app.";
            return;
          }
          $("signInDialog").close();
          connect();   // the worker still wins when it answers
        })
        .catch(function (error) { message.hidden = false; message.textContent = error.message; })
        .then(function () { button.disabled = false; button.textContent = "Sign in"; });
    });
    $("mfaStart").addEventListener("click", function () {
      var message = $("signInMessage");
      message.hidden = true;
      SB.enrol().then(function (d) {
        var qr = (d.totp && d.totp.qr_code) || "";
        $("mfaQr").src = qr.indexOf("data:") === 0 ? qr : "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qr);
        $("mfaSecret").textContent = (d.totp && d.totp.secret) || "";
        $("mfaEnrol").dataset.factor = d.id;
        $("mfaEnrol").hidden = false; $("mfaStart").hidden = true;
        $("mfaCode").value = ""; $("mfaCode").focus();
      }).catch(function (e) { message.hidden = false; message.textContent = "Set-up failed: " + e.message; });
    });
    $("mfaConfirm").addEventListener("click", function () {
      var message = $("signInMessage");
      message.hidden = true;
      SB.verifyCode($("mfaEnrol").dataset.factor, $("mfaCode").value.trim())
        .then(function () { return SB.refreshUser(); })
        .then(function () {
          $("mfaEnrol").hidden = true; $("mfaSecret").textContent = ""; $("mfaQr").removeAttribute("src");
          showFactorState();
          message.hidden = false;
          message.textContent = "Two-step sign-in is on. Now give the PC and the MacBook the secret, "
            + "then run the SQL file. See supabase/SETUP.md, section 8.";
        })
        .catch(function (e) { message.hidden = false; message.textContent = "The code was not accepted: " + e.message; });
    });
    $("docEdit").addEventListener("click", function () {
      DOC.editing = true; $("docText").value = DOC.row.body; showDoc(); $("docText").focus();
    });
    $("docCancel").addEventListener("click", function () {
      if (dirty() && !confirm("Discard your changes to this note?")) return;
      DOC.editing = false; reloadDoc();
    });
    $("docSave").addEventListener("click", saveDoc);
    $("docAppend").addEventListener("submit", appendLine);
    $("docClose").addEventListener("click", function () { closeDoc(); });
    $("docDialog").addEventListener("cancel", closeDoc);   // the Escape key
    $("signOutButton").addEventListener("click", function () {
      SB.signOut();
      $("signInDialog").close();
      S.cloud = false;
      connect();
    });
    $("addForm").addEventListener("submit", onAdd);
    $("settingsForm").addEventListener("submit", onSettings);
    $("logCancel").addEventListener("click", function () {
      api("POST", "/api/tasks/" + encodeURIComponent(S.logTask) + "/cancel", {}).then(pollLog).catch(function (e) { alert(e.message); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (b) {
      b.addEventListener("click", function () { b.closest("dialog").close(); });
    });
    $("logDialog").addEventListener("close", function () { clearTimeout(S.logTimer); S.logTask = null; });
    setConnection(); render();
    // A session saved before the account got its second factor does not know of it.
    // Ask for the user record first, so the page asks for the code instead of
    // showing an empty table.
    if (SB.configured() && SB.session()) SB.refreshUser().catch(function () {}).then(connect);
    else connect();
  }

  // The sign-in dialog shows either the email and password, or the code step.
  function codeStep(on) {
    var f = $("signInForm");
    $("signInEmailRow").hidden = on; $("signInPasswordRow").hidden = on;
    f.elements.email.required = !on; f.elements.password.required = !on;
    $("signInCodeRow").hidden = !on; f.elements.code.required = on;
    if (on) f.elements.code.focus();
  }

  function showFactorState() {
    var signedIn = SB.ready();
    $("mfaSection").hidden = !signedIn;
    if (!signedIn) return;
    var on = !!SB.factor();
    $("mfaState").textContent = on
      ? "On. Each new sign-in asks for a code from your authenticator app."
      : "Off. One password protects the account. Set up an authenticator app to add a second step.";
    $("mfaStart").hidden = on;
    $("mfaEnrol").hidden = true;
  }

  boot();
})();
