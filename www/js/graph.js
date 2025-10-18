// www/js/graph.js
(async function () {
  // --- Wait for Quarto sidebar to be injected ---
  const awaitSidebar = () =>
    new Promise((resolve) => {
      if (window.KASMO_SIDEBAR) return resolve();
      const t = setInterval(() => {
        if (window.KASMO_SIDEBAR) { clearInterval(t); resolve(); }
      }, 30);
    });
  await awaitSidebar();

  // Sidebar refs
  const panel = window.KASMO_SIDEBAR;
  const sidebar = {
    selectedLabel: panel.selectedLabel,
    def: panel.def,
    related: panel.related,
    tags: panel.tags
  };
  const search   = panel.search;
  const resetBtn = panel.reset;
  const langBtn  = panel.lang;

  // (Optional) Prev/Next buttons if you added them in index.qmd
  const prevBtn  = panel.prev || null;
  const nextBtn  = panel.next || null;

  // Lang param
  window.KASMO_PARAMS = window.KASMO_PARAMS || { lang: "so" };
  const lang = () => (window.KASMO_PARAMS.lang || "so");

  // Track last selection for Prev/Next
  let currentId = null;

  // Sizing
  const el = document.getElementById("graph");
  function getSize() {
    const sb = document.getElementById("quarto-sidebar");
    const sbw = sb ? sb.offsetWidth : 0;
    const w = Math.max(320, window.innerWidth - sbw);
    const h = Math.max(320, window.innerHeight);
    return { width: w, height: h };
  }
  let { width, height } = getSize();

  // SVG
  const svg = d3.select("#graph").append("svg")
    .attr("width", width).attr("height", height)
    .attr("role", "img").attr("aria-label", "Kasmo interactive network");

  const gZoom  = svg.append("g");
  const gLink  = gZoom.append("g").attr("fill", "none");
  const gNode  = gZoom.append("g");
  const gLabel = gZoom.append("g");

  // --- Load data (new schema) ---
  let graph;
  try {
    const resp = await fetch("data/graph.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    graph = await resp.json();
  } catch (e) {
    const msg = `Could not load data/graph.json — ${e}`;
    console.error(msg);
    d3.select("#graph").append("div").style("padding","1rem").style("color","#b91c1c").text(msg);
    throw e;
  }

  // Build name dictionaries from links (term_so/term_en for sources, target_en for targets)
  const nameSO = new Map();  // id -> Somali label
  const nameEN = new Map();  // id -> English label
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  for (const l of rawLinks) {
    if (l.source_id) {
      const sid = String(l.source_id);
      if (l.term_so) nameSO.set(sid, l.term_so);
      if (l.term_en) nameEN.set(sid, l.term_en);
    }
    if (l.target_id) {
      const tid = String(l.target_id);
      // Somali target is commonly the id itself
      if (!nameSO.has(tid)) nameSO.set(tid, tid);
      if (l.target_en && !nameEN.has(tid)) nameEN.set(tid, l.target_en);
    }
  }

  // Nodes
  const nodes = (graph.nodes || []).map(d => {
    const id = String(d.id);
    return {
      ...d,
      id,
      tags: d.tags || "",
      // preferred display names
      term_so: d.term_so || nameSO.get(id) || id,
      term_en: d.term_en || nameEN.get(id) || id,
      _degProvided: +d.degree || 0
    };
  });
  const idIndex = new Map(nodes.map((d,i)=>[d.id, i]));

  // Links
  const links = rawLinks
    .map(l => ({
      source: String(l.source_id),
      target: String(l.target_id),
      weight: +l.weight || 1,
      def_so: l.def_so || "",
      def_en: l.def_en || "",
    }))
    .filter(l => idIndex.has(l.source) && idIndex.has(l.target));

  // Compute degree if not provided
  nodes.forEach(n => (n._deg = n._degProvided));
  if (!nodes.every(n => n._degProvided > 0)) {
    nodes.forEach(n => (n._deg = 0));
    links.forEach(l => { nodes[idIndex.get(l.source)]._deg++; nodes[idIndex.get(l.target)]._deg++; });
  }

  // Palette & scales
  const palette = {
    nodeFill:  "#f4b183",
    nodeStroke:"#8b2d2b",
    linkStroke:"#c0504d",
    linkHi:    "#a12d2a"
  };

  const r = d3.scaleSqrt()
    .domain([1, d3.max(nodes, d => d._deg || 1) || 1])
    .range([4, 14]);

  const linkWidth = d3.scaleLinear()
    .domain([1, d3.max(links, d => d.weight) || 1])
    .range([0.6, 2.8]);

  // Cap label size so hubs don't dominate
  const MAX_LABEL_PX = 22;
  const labelSize = d3.scaleLinear()
    .domain([1, d3.max(nodes, d => d._deg || 1) || 1])
    .range([10, MAX_LABEL_PX])
    .clamp(true);

  const labelThreshold = d3.quantile(nodes.map(d => d._deg).sort((a,b)=>a-b), 0.75) || 2;

  // Current label accessor by language
  const nodeLabel = (d) => lang() === "en" ? (d.term_en || d.term_so || d.id) : (d.term_so || d.term_en || d.id);

  // Simulation
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(60).strength(0.15))
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(width/2, height/2))
    .force("collide", d3.forceCollide().radius(d => r(d._deg||1) + 3));

  // Curved links
  const link = gLink.selectAll("path")
    .data(links)
    .join("path")
    .attr("stroke", palette.linkStroke)
    .attr("stroke-opacity", 0.25)
    .attr("stroke-width", d => linkWidth(d.weight));

  // Nodes
  const node = gNode.selectAll("circle")
    .data(nodes)
    .join("circle")
      .attr("r", d => r(d._deg || 1))
      .attr("fill", palette.nodeFill)
      .attr("stroke", palette.nodeStroke)
      .attr("stroke-width", 1.2)
      .attr("tabindex", 0)
      .on("click", (_, d) => selectNode(d))
      .on("keydown", (ev, d) => { if (ev.key === "Enter") selectNode(d); })
      .call(d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end",   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      );

  // Labels (halo + text)
  const labelHalo = gLabel.selectAll("text.halo")
    .data(nodes)
    .join("text")
      .attr("class", "halo")
      .attr("text-anchor", "middle")
      .attr("stroke", "white")
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .style("pointer-events", "none")
      .style("font-family", "system-ui, -apple-system, Segoe UI, Roboto, sans-serif")
      .style("opacity", d => d._deg >= labelThreshold ? 1 : 0);

  const label = gLabel.selectAll("text.label")
    .data(nodes)
    .join("text")
      .attr("class", "label")
      .attr("text-anchor", "middle")
      .style("pointer-events", "none")
      .style("fill", "#222")
      .style("font-weight", d => d._deg >= labelThreshold ? 700 : 500)
      .style("font-family", "system-ui, -apple-system, Segoe UI, Roboto, sans-serif")
      .style("opacity", d => d._deg >= labelThreshold ? 1 : 0)
      .text(d => nodeLabel(d));

  // ★ Name the zoom so we can reset it later
  const zoom = d3.zoom()
    .extent([[0,0],[width,height]])
    .scaleExtent([0.3, 6])
    .on("zoom", (ev) => gZoom.attr("transform", ev.transform));

  svg.call(zoom);

  // ★ Helper to reset zoom/pan smoothly
  function resetView() {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    sim.alpha(0.15).restart();
  }

  // Tick
  sim.on("tick", () => {
    link.attr("d", d => {
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const len = Math.hypot(dx, dy) || 1;
      const k = 18;
      const cx = mx - (dy / len) * k;
      const cy = my + (dx / len) * k;
      return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
    });

    node.attr("cx", d => d.x).attr("cy", d => d.y);

    labelHalo
      .attr("x", d => d.x)
      .attr("y", d => d.y + r(d._deg||1) + 3)
      .style("font-size", d => `${labelSize(d._deg||1)}px`);

    label
      .attr("x", d => d.x)
      .attr("y", d => d.y + r(d._deg||1) + 3)
      .style("font-size", d => `${labelSize(d._deg||1)}px`)
      .text(d => nodeLabel(d));
  });

  // Resize
  const ro = new ResizeObserver(() => {
    const s = getSize();
    width = s.width; height = s.height;
    svg.attr("width", width).attr("height", height);
    sim.force("center", d3.forceCenter(width/2, height/2));
    sim.alpha(0.15).restart();
  });
  ro.observe(el);
  const sidebarEl = document.getElementById("quarto-sidebar");
  if (sidebarEl) ro.observe(sidebarEl);

  // Helpers
  const neighbors = (id) => {
    const s = new Set([id]);
    links.forEach(l => {
      if (l.source.id === id) s.add(l.target.id);
      if (l.target.id === id) s.add(l.source.id);
    });
    return s;
  };

  // ★ Find the "central" node by tags (case-insensitive match on 'Central')
  function findCentralNode() {
    const isCentral = (t) => (t || "").toString().toLowerCase().split(/[,\s;]+/).includes("central");
    const picks = nodes.filter(n => isCentral(n.tags));
    if (picks.length) {
      // prefer the most connected if multiple are tagged
      return picks.slice().sort((a,b) => (b._deg||0) - (a._deg||0))[0];
    }
    // fallback: biggest hub if none tagged (keeps behavior robust)
    return nodes.slice().sort((a,b) => (b._deg||0) - (a._deg||0))[0] || null;
  }

  // definition from links (outgoing only)
  function definitionFromLinks(nodeId) {
    const wantEn = (typeof lang === "function" ? lang() : (window.KASMO_PARAMS?.lang || "so")) === "en";
    const snippets = [];

    for (const l of links) {
      const sid = (l.source && typeof l.source === "object") ? String(l.source.id) : String(l.source);
      if (sid !== String(nodeId)) continue;

      const txt = (wantEn ? l.def_en : l.def_so) || "";
      const cleaned = txt.replace(/\s+/g, " ").trim();
      if (cleaned) snippets.push(cleaned);
    }

    if (!snippets.length) return "";
    const uniq = Array.from(new Set(snippets));
    uniq.sort((a, b) => b.length - a.length);
    return uniq[0];
  }

  function emphasizeSelection(d) {
    const neigh = neighbors(d.id);
    node
      .attr("fill", n => neigh.has(n.id) ? palette.nodeFill : "#efefef")
      .attr("stroke", n => neigh.has(n.id) ? palette.nodeStroke : "#bdbdbd")
      .attr("stroke-width", n => n.id === d.id ? 3 : 1.0)
      .attr("opacity", n => neigh.has(n.id) ? 1 : 0.25);

    link
      .attr("stroke", l =>
        l.source.id === d.id || l.target.id === d.id ? palette.linkHi : palette.linkStroke
      )
      .attr("stroke-opacity", l =>
        l.source.id === d.id || l.target.id === d.id ? 0.45 : 0.12
      )
      .attr("stroke-width", l =>
        (l.source.id === d.id || l.target.id === d.id) ? Math.max(1.5, linkWidth(l.weight)+0.6) : linkWidth(l.weight)
      );

    // Limit visible labels among neighbors to reduce clutter
    const neighList = nodes.filter(n => neigh.has(n.id));
    neighList.sort((a,b) => (b._deg||0) - (a._deg||0));
    const VISIBLE_NEIGHBOR_LABELS = 12; // tweak if you like
    const allow = new Set(neighList.slice(0, VISIBLE_NEIGHBOR_LABELS).map(n => n.id));
    allow.add(d.id); // always show selected

    label.style("opacity", n =>
      (allow.has(n.id) || n._deg >= labelThreshold) ? 1 : 0.05
    );
    labelHalo.style("opacity", n =>
      (allow.has(n.id) || n._deg >= labelThreshold) ? 1 : 0
    );

  }

  function clearEmphasis() {
    node.attr("fill", palette.nodeFill).attr("stroke", palette.nodeStroke).attr("stroke-width", 1.2).attr("opacity", 1);
    link.attr("stroke", palette.linkStroke).attr("stroke-opacity", 0.25).attr("stroke-width", d => linkWidth(d.weight));
    label.style("opacity", d => d._deg >= labelThreshold ? 1 : 0);
    labelHalo.style("opacity", d => d._deg >= labelThreshold ? 1 : 0);
  }

  function selectNode(d) {
    const def = definitionFromLinks(d.id) || "—";
    sidebar.selectedLabel.textContent = nodeLabel(d);
    sidebar.def.classList.remove("text-muted");
    sidebar.def.innerHTML = def;

    const neigh = neighbors(d.id);
    const related = nodes.filter(n => n.id !== d.id && neigh.has(n.id)).slice(0, 3);
    sidebar.related.innerHTML = related.length
      ? '<ul class="related-list">' + related.map(n => `<li>${nodeLabel(n)}</li>`).join("") + '</ul>'
      : '<span class="muted">—</span>';
    const tag = (d.tags || "").trim();
    sidebar.tags.classList.add("small", "text-muted");
    sidebar.tags.textContent = tag || "—";

    // remember current selection for Prev/Next
    currentId = d.id;

    emphasizeSelection(d);
    history.replaceState(null, "", `#id=${encodeURIComponent(d.id)}`);
  }

  // --- Prev/Next helpers (use current language sort order) ---
  function orderedIdsByLabel() {
    const arr = nodes.slice().sort((a, b) =>
      nodeLabel(a).localeCompare(nodeLabel(b), undefined, { sensitivity: 'base' })
    );
    return arr.map(d => d.id);
  }
  function selectByOffset(step) {
    const order = orderedIdsByLabel();
    const len = order.length;
    let idx = 0;

    if (currentId && idIndex.has(currentId)) {
      const pos = order.indexOf(currentId);
      idx = pos >= 0 ? pos : 0;
    }
    const nextIdx = (idx + step + len) % len;
    const id = order[nextIdx];
    const d = nodes[idIndex.get(id)];
    selectNode(d);
  }

  // URL hash OR default to central node on first load  ★
  const fromHash = (() => {
    const m = (window.location.hash || "").match(/id=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();
  if (fromHash && idIndex.has(fromHash)) {
    selectNode(nodes[idIndex.get(fromHash)]);
  } else {
    const central = findCentralNode();
    if (central) selectNode(central);  // this sets currentId too
  }

  // Search
  function matchesQuery(n, q) {
    const so = (n.term_so || "").toLowerCase();
    const en = (n.term_en || "").toLowerCase();
    const id = (n.id || "").toLowerCase();
    return so.includes(q) || en.includes(q) || id.includes(q);
  }
  search.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { clearEmphasis(); return; }
    const hitIds = new Set(nodes.filter(n => matchesQuery(n, q)).map(n => n.id));
    node.attr("opacity", n => hitIds.has(n.id) ? 1 : 0.15);
    label.style("opacity", n => hitIds.has(n.id) ? 1 : 0.05);
    labelHalo.style("opacity", n => hitIds.has(n.id) ? 1 : 0);
    link.attr("stroke-opacity", 0.07);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = e.target.value.trim().toLowerCase();
      const hit = nodes.find(n => matchesQuery(n, q));
      if (hit) selectNode(hit);
    }
  });

  // Reset & language toggle
  resetBtn.addEventListener("click", () => {
    sidebar.selectedLabel.textContent = "";
    sidebar.def.classList.add("text-muted");
    sidebar.def.textContent = "";
    sidebar.related.innerHTML = '<span class="muted">—</span>';
    sidebar.tags.classList.add("small", "text-muted");
    sidebar.tags.textContent = "—";
    clearEmphasis();
    history.replaceState(null, "", "#");

    // ★ reset zoom/pan and then show central node again
    resetView();
    const central = findCentralNode();
    if (central) selectNode(central);   // sets currentId as well
  });

  // Language toggle keeps current selection; labels update
  langBtn.addEventListener("click", () => {
    window.KASMO_PARAMS.lang = (lang() === "so") ? "en" : "so";
    // Update all labels immediately
    label.text(d => nodeLabel(d));

    // Re-render the same node in the other language (if selected)
    if (currentId && idIndex.has(currentId)) {
      selectNode(nodes[idIndex.get(currentId)]);
    } else {
      const id = (window.location.hash.match(/id=([^&]+)/) || [])[1];
      if (id && idIndex.has(decodeURIComponent(id))) {
        selectNode(nodes[idIndex.get(decodeURIComponent(id))]);
      }
    }
  });

  // Wire Prev/Next if present
  if (prevBtn) prevBtn.addEventListener('click', () => selectByOffset(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => selectByOffset(1));
})();
