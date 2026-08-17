import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import type { GitData, BranchLane, CommitNode, CommitEdge } from '../types';

interface TimelineProps {
  data: GitData;
  onCommitClick: (commitId: string) => void;
  selectedCommitId: string | null;
  /** Increments when a repository is (re)opened — the only time the viewport resets. */
  resetKey: number;
  /** "View from this branch" (lane context menu). */
  onViewFromBranch: (branchName: string) => void;
}

const LANE_HEIGHT = 80;
const MINIMAP_W = 220;
const MINIMAP_H = 120;

interface LaneMenu {
  x: number;
  y: number;
  lane: BranchLane;
}

function nodeRadius(c: CommitNode): number {
  const volume = c.additions + c.deletions;
  if (volume <= 0) return 7;
  return 7 + Math.min(7, Math.sqrt(volume) / 2.5);
}

export function Timeline({ data, onCommitClick, selectedCommitId, resetKey, onViewFromBranch }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const minimapRef = useRef<SVGSVGElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const resetKeyRef = useRef(-1);
  const [hoveredCommit, setHoveredCommit] = useState<CommitNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [laneMenu, setLaneMenu] = useState<LaneMenu | null>(null);

  // View options (gmaster-style display options)
  const [compressed, setCompressed] = useState(true);
  const [showMergeLinks, setShowMergeLinks] = useState(true);
  const [showRefLabels, setShowRefLabels] = useState(true);
  const [focusedLane, setFocusedLane] = useState<string | null>(null);
  const [expandedLanes, setExpandedLanes] = useState<Set<string>>(new Set());

  const commitMap = useMemo(() => new Map(data.commits.map(c => [c.id, c])), [data]);
  const branchColorMap = useMemo(() => new Map(data.branches.map(b => [b.name, b.color])), [data]);

  // Reset view-local state when a different repository is opened.
  useEffect(() => {
    setFocusedLane(null);
    setExpandedLanes(new Set());
    setLaneMenu(null);
  }, [resetKey]);

  const visibleCommits = useMemo(() => {
    if (!compressed) return data.commits;
    return data.commits.filter(c => c.is_key || expandedLanes.has(c.lane_owner));
  }, [data, compressed, expandedLanes]);

  const hiddenCountByLane = useMemo(() => {
    const m = new Map<string, number>();
    if (!compressed) return m;
    for (const c of data.commits) {
      if (!c.is_key && !expandedLanes.has(c.lane_owner)) {
        m.set(c.lane_owner, (m.get(c.lane_owner) ?? 0) + 1);
      }
    }
    return m;
  }, [data, compressed, expandedLanes]);

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const draw = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return;

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const g = svg.append('g').attr('class', 'timeline-content');
    const dimOthers = (name: string) => focusedLane !== null && focusedLane !== name;
    const laneOpacity = (name: string) => (dimOthers(name) ? 0.12 : 1);

    // --- zoom ----------------------------------------------------------------
    const minimapViewport = () => {
      if (!minimapRef.current) return;
      const t = transformRef.current;
      const allX = data.commits.map(c => c.x);
      const scene = {
        x0: Math.min(...allX, 0) - 180,
        x1: Math.max(...allX, 100) + 200,
        y0: -LANE_HEIGHT,
        y1: (data.branches.length) * LANE_HEIGHT,
      };
      const sx = MINIMAP_W / (scene.x1 - scene.x0);
      const sy = MINIMAP_H / (scene.y1 - scene.y0);
      const s = Math.min(sx, sy);
      // screen = t * scene ; scene->mini = s ; viewport rect in mini coords:
      const vx = (-t.x / t.k - scene.x0) * s;
      const vy = (-t.y / t.k - scene.y0) * s;
      const vw = (width / t.k) * s;
      const vh = (height / t.k) * s;
      d3.select(minimapRef.current).select('.mm-viewport')
        .attr('x', vx).attr('y', vy)
        .attr('width', Math.max(6, vw)).attr('height', Math.max(6, vh));
    };

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.005, 40])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        transformRef.current = event.transform;
        g.attr('transform', event.transform.toString());
        minimapViewport();
      });
    svg.call(zoom);

    const allX = data.commits.map(c => c.x);
    const minX = Math.min(...allX, 0) - 180;
    const maxX = Math.max(...allX, 100) + 200;
    const minY = Math.min(...data.commits.map(c => c.y), 0) - LANE_HEIGHT;
    const maxY = Math.max(...data.commits.map(c => c.y), 0) + LANE_HEIGHT;
    // No viewBox: the scene lives in plain pixel space and the zoom transform
    // owns all scaling. (viewBox + zoom double-scales, which made large repos
    // render microscopically small.)

    // --- time ruler (top, inside the zoomable scene) --------------------------
    if (data.commits.length > 1) {
      const tMin = Math.min(...data.commits.map(c => c.timestamp));
      const tMax = Math.max(...data.commits.map(c => c.timestamp));
      const xOf = new Map(data.commits.map(c => [c.timestamp, c.x]));
      const timeScale = d3.scaleTime()
        .domain([new Date(tMin * 1000), new Date(tMax * 1000)])
        .range([xOf.get(tMin) ?? 0, xOf.get(tMax) ?? 1]);
      g.append('g')
        .attr('class', 'time-ruler')
        .attr('transform', `translate(0, ${minY + 18})`)
        .call(d3.axisTop(timeScale).ticks(8).tickSize(4))
        .call(sel => {
          sel.selectAll('text').attr('fill', '#666').attr('font-size', '10px');
          sel.selectAll('line,path').attr('stroke', '#444');
        });
    }

    // --- lane guide lines ------------------------------------------------------
    g.selectAll('.lane')
      .data(data.branches)
      .enter()
      .append('line')
      .attr('class', 'lane')
      .attr('x1', minX - 50)
      .attr('x2', maxX + 50)
      .attr('y1', (d: BranchLane) => d.lane_index * LANE_HEIGHT)
      .attr('y2', (d: BranchLane) => d.lane_index * LANE_HEIGHT)
      .attr('stroke', (d: BranchLane) => d.color)
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4')
      .attr('opacity', (d: BranchLane) => dimOthers(d.name) ? 0.05 : 0.3);

    // --- branch bars (span ALL commits of the lane, compression-proof) --------
    const laneSpan = new Map<number, { min: number; max: number }>();
    for (const c of data.commits) {
      const span = laneSpan.get(c.lane) ?? { min: c.x, max: c.x };
      span.min = Math.min(span.min, c.x);
      span.max = Math.max(span.max, c.x);
      laneSpan.set(c.lane, span);
    }
    g.selectAll('.lane-bar')
      .data(data.branches.filter(b => laneSpan.has(b.lane_index)))
      .enter()
      .append('line')
      .attr('class', 'lane-bar')
      .attr('x1', (d: BranchLane) => laneSpan.get(d.lane_index)!.min)
      .attr('x2', (d: BranchLane) => laneSpan.get(d.lane_index)!.max)
      .attr('y1', (d: BranchLane) => d.lane_index * LANE_HEIGHT)
      .attr('y2', (d: BranchLane) => d.lane_index * LANE_HEIGHT)
      .attr('stroke', (d: BranchLane) => d.color)
      .attr('stroke-width', 4)
      .attr('stroke-linecap', 'round')
      .attr('opacity', (d: BranchLane) => dimOthers(d.name) ? 0.12 : 0.55)
      .style('cursor', 'context-menu')
      .on('contextmenu', (event: MouseEvent, d: BranchLane) => {
        event.preventDefault();
        setLaneMenu({ x: event.clientX, y: event.clientY, lane: d });
      });

    // --- lane labels (left) ----------------------------------------------------
    g.selectAll('.lane-label')
      .data(data.branches)
      .enter()
      .append('text')
      .attr('class', 'lane-label')
      .attr('x', minX + 8)
      .attr('y', (d: BranchLane) => d.lane_index * LANE_HEIGHT + 4)
      .attr('font-size', '11px')
      .attr('fill', (d: BranchLane) => d.color)
      .attr('text-anchor', 'start')
      .attr('opacity', (d: BranchLane) => laneOpacity(d.name))
      .style('cursor', 'pointer')
      .text((d: BranchLane) => d.name)
      .on('click', (_e: MouseEvent, d: BranchLane) => {
        setFocusedLane(prev => (prev === d.name ? null : d.name));
      })
      .on('contextmenu', (event: MouseEvent, d: BranchLane) => {
        event.preventDefault();
        setLaneMenu({ x: event.clientX, y: event.clientY, lane: d });
      });

    // --- edges -----------------------------------------------------------------
    const visibleIds = new Set(visibleCommits.map(c => c.id));
    const visibleEdges = data.edges.filter(e => {
      if (!showMergeLinks && e.edge_type === 'Merge') return false;
      if (e.edge_type === 'Direct') return visibleIds.has(e.from) && visibleIds.has(e.to);
      return visibleIds.has(e.from) && visibleIds.has(e.to); // Branch/Merge endpoints are key nodes
    });

    g.selectAll('.edge')
      .data(visibleEdges)
      .enter()
      .append('path')
      .attr('class', 'edge')
      .attr('d', (d: CommitEdge) => {
        const from = commitMap.get(d.from);
        const to = commitMap.get(d.to);
        if (!from || !to) return '';

        if (d.edge_type === 'Direct') {
          return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
        }
        if (d.edge_type === 'Merge') {
          // merge link: thin, gentle curve into the merge commit
          const midX = (from.x + to.x) / 2;
          return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
        }
        // fork (Branch): right-angle polyline — drop from parent lane, then
        // horizontal into the child lane's first commit (gmaster style)
        const midX = from.x - 24;
        return `M ${to.x} ${to.y} L ${midX} ${to.y} L ${midX} ${from.y} L ${from.x} ${from.y}`;
      })
      .attr('fill', 'none')
      .attr('stroke', (d: CommitEdge) => {
        const from = commitMap.get(d.from);
        return from ? branchColorMap.get(from.lane_owner) ?? '#888' : '#888';
      })
      .attr('stroke-width', (d: CommitEdge) => d.edge_type === 'Direct' ? 2.5 : d.edge_type === 'Branch' ? 1.8 : 1.3)
      .attr('opacity', (d: CommitEdge) => {
        const from = commitMap.get(d.from);
        if (!from) return 0.5;
        if (focusedLane && d.edge_type === 'Merge') {
          // in focus mode keep merge links touching the focused lane visible
          const to = commitMap.get(d.to);
          const touches = from.lane_owner === focusedLane || to?.lane_owner === focusedLane;
          return touches ? 0.9 : 0.06;
        }
        return dimOthers(from.lane_owner) ? 0.08 : (d.edge_type === 'Merge' ? 0.7 : 0.9);
      });

    // --- collapsed-segment chips ------------------------------------------------
    if (compressed) {
      const chipData = data.branches
        .map(b => ({ lane: b, hidden: hiddenCountByLane.get(b.name) ?? 0 }))
        .filter(d => d.hidden > 0 && laneSpan.has(d.lane.lane_index));
      const chips = g.selectAll('.collapse-chip')
        .data(chipData)
        .enter()
        .append('g')
        .attr('class', 'collapse-chip')
        .attr('transform', d => {
          const span = laneSpan.get(d.lane.lane_index)!;
          return `translate(${(span.min + span.max) / 2}, ${d.lane.lane_index * LANE_HEIGHT})`;
        })
        .style('cursor', 'pointer')
        .on('click', (_e, d) => {
          setExpandedLanes(prev => new Set(prev).add(d.lane.name));
        });
      chips.append('rect')
        .attr('x', -18).attr('y', -9)
        .attr('width', 36).attr('height', 18)
        .attr('rx', 9)
        .attr('fill', '#2a2a2a')
        .attr('stroke', d => d.lane.color)
        .attr('stroke-width', 1);
      chips.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', 3)
        .attr('font-size', '9px')
        .attr('fill', '#bbb')
        .text(d => `+${d.hidden}`);
      chips.append('title').text(d => `${d.hidden} commits collapsed — click to expand`);
    }

    // --- nodes -------------------------------------------------------------------
    const nodes = g.selectAll('.node')
      .data(visibleCommits)
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y})`)
      .attr('opacity', (d: CommitNode) => laneOpacity(d.lane_owner))
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d: CommitNode) => {
        event.stopPropagation();
        onCommitClick(d.id);
      })
      .on('mouseenter', (event: MouseEvent, d: CommitNode) => {
        setHoveredCommit(d);
        setTooltipPos({ x: event.clientX, y: event.clientY });
      })
      .on('mousemove', (event: MouseEvent) => {
        setTooltipPos({ x: event.clientX, y: event.clientY });
      })
      .on('mouseleave', () => setHoveredCommit(null));

    nodes.append('circle')
      .attr('r', nodeRadius)
      .attr('fill', (d: CommitNode) => branchColorMap.get(d.lane_owner) ?? '#4A90D9')
      .attr('stroke', (d: CommitNode) => d.id === selectedCommitId ? '#fff' : 'transparent')
      .attr('stroke-width', (d: CommitNode) => d.id === selectedCommitId ? 3 : 0);

    const headNodes = nodes.filter((d: CommitNode) => d.is_head);
    headNodes.append('circle')
      .attr('r', (d: CommitNode) => nodeRadius(d) + 5)
      .attr('fill', 'none')
      .attr('stroke', '#4CAF50')
      .attr('stroke-width', 2);
    headNodes.append('text')
      .attr('y', (d: CommitNode) => -nodeRadius(d) - 10)
      .attr('font-size', '10px')
      .attr('font-weight', 'bold')
      .attr('fill', '#4CAF50')
      .attr('text-anchor', 'middle')
      .text('HEAD');

    nodes.append('title')
      .text((d: CommitNode) => `${d.short_id}\n${d.message}\n${d.author_name}\n${formatTime(d.timestamp)}`);

    // --- node labels (short id + message, key nodes only when compressed) --------
    const labels = g.selectAll('.label')
      .data(visibleCommits)
      .enter()
      .append('g')
      .attr('class', 'label')
      .attr('transform', (d: CommitNode) => `translate(${d.x + nodeRadius(d) + 7}, ${d.y - 5})`)
      .attr('opacity', (d: CommitNode) => laneOpacity(d.lane_owner));

    labels.append('text')
      .attr('font-size', '11px')
      .attr('fill', '#ccc')
      .text((d: CommitNode) => d.short_id);
    labels.append('text')
      .attr('font-size', '10px')
      .attr('fill', '#888')
      .attr('y', 12)
      .text((d: CommitNode) => d.message.length > 30 ? d.message.slice(0, 30) + '…' : d.message);

    // --- ref badges (stacked, above the node) -------------------------------------
    if (showRefLabels) {
      const badgeGroups = g.selectAll('.ref-badges')
        .data(visibleCommits.filter(c => c.branch_refs.length > 0))
        .enter()
        .append('g')
        .attr('class', 'ref-badges')
        .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y - nodeRadius(d) - 8})`);
      badgeGroups.each(function (c: CommitNode) {
        const grp = d3.select(this);
        c.branch_refs.forEach((ref, i) => {
          const w = ref.name.length * 6 + 12;
          const item = grp.append('g').attr('transform', `translate(${-w / 2}, ${-i * 18})`);
          item.append('rect')
            .attr('x', 0).attr('y', -13)
            .attr('width', w).attr('height', 16)
            .attr('rx', 8)
            .attr('fill', ref.is_tag ? '#9C27B0' : branchColorMap.get(c.lane_owner) ?? '#4A90D9')
            .attr('opacity', 0.9);
          item.append('text')
            .attr('x', w / 2).attr('y', -2)
            .attr('text-anchor', 'middle')
            .attr('font-size', '9px')
            .attr('fill', '#fff')
            .text(ref.name);
        });
      });
    }

    // --- fork / merge annotations ---------------------------------------------------
    g.selectAll('.fork-label')
      .data(visibleCommits.filter(c => c.fork_branch_name))
      .enter()
      .append('text')
      .attr('class', 'fork-label')
      .attr('x', (d: CommitNode) => d.x)
      .attr('y', (d: CommitNode) => d.y + 24)
      .attr('font-size', '9px')
      .attr('fill', '#4A90D9')
      .attr('text-anchor', 'middle')
      .text((d: CommitNode) => `⑂ ${d.fork_branch_name}`);

    g.selectAll('.merge-label')
      .data(visibleCommits.filter(c => c.merge_branch_name && showMergeLinks))
      .enter()
      .append('text')
      .attr('class', 'merge-label')
      .attr('x', (d: CommitNode) => d.x)
      .attr('y', (d: CommitNode) => d.y - nodeRadius(d) - 8)
      .attr('font-size', '9px')
      .attr('fill', '#E91E63')
      .attr('text-anchor', 'middle')
      .text((d: CommitNode) => `⤶ ${d.merge_branch_name}`);

    // --- minimap ----------------------------------------------------------------------
    if (minimapRef.current) {
      const mm = d3.select(minimapRef.current);
      mm.selectAll('*').remove();
      mm.attr('width', MINIMAP_W).attr('height', MINIMAP_H);
      const sceneW = maxX - minX;
      const sceneH = maxY - minY;
      const s = Math.min(MINIMAP_W / sceneW, MINIMAP_H / sceneH);
      const mx = (x: number) => (x - minX) * s;
      const my = (y: number) => (y - minY) * s;
      for (const b of data.branches) {
        mm.append('line')
          .attr('x1', 0).attr('x2', MINIMAP_W)
          .attr('y1', my(b.lane_index * LANE_HEIGHT))
          .attr('y2', my(b.lane_index * LANE_HEIGHT))
          .attr('stroke', b.color).attr('stroke-width', 0.8).attr('opacity', 0.35);
      }
      for (const c of data.commits) {
        mm.append('circle')
          .attr('cx', mx(c.x)).attr('cy', my(c.y))
          .attr('r', c.is_key ? 2 : 1.1)
          .attr('fill', branchColorMap.get(c.lane_owner) ?? '#888');
      }
      mm.append('rect')
        .attr('class', 'mm-viewport')
        .attr('fill', 'none')
        .attr('stroke', '#4A90D9')
        .attr('stroke-width', 1);
      mm.on('click', (event: MouseEvent) => {
        const [px, py] = d3.pointer(event, minimapRef.current);
        const sceneX = px / s + minX;
        const sceneY = py / s + minY;
        const t = transformRef.current;
        const next = d3.zoomIdentity
          .translate(width / 2 - sceneX * t.k, height / 2 - sceneY * t.k)
          .scale(t.k);
        svg.call(zoom.transform, next);
      });
    }

    // --- viewport: reset only when a repo was (re)opened ------------------------------
    const shouldReset = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (data.commits.length > 0 && shouldReset) {
      // Fit the whole scene into the viewport (10% padding), capped at 1x.
      const sceneW = maxX - minX;
      const sceneH = maxY - minY;
      const k = Math.min(width / sceneW, height / sceneH, 1) * 0.9;
      const t = d3.zoomIdentity
        .translate(width / 2 - (minX + sceneW / 2) * k, height / 2 - (minY + sceneH / 2) * k)
        .scale(k);
      svg.call(zoom.transform, t);
      transformRef.current = t;
    } else {
      svg.call(zoom.transform, transformRef.current);
    }
    minimapViewport();
  }, [data, onCommitClick, selectedCommitId, resetKey, compressed, showMergeLinks, showRefLabels, focusedLane, expandedLanes, hiddenCountByLane, visibleCommits, commitMap, branchColorMap]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  return (
    <div ref={containerRef} className="timeline-container" onClick={() => setLaneMenu(null)}>
      <svg ref={svgRef}></svg>

      <div className="view-toolbar">
        <button
          className={`view-btn ${compressed ? 'active' : ''}`}
          onClick={() => setCompressed(v => !v)}
          title="Smart compression: show only lane births, tips, merges, tags, HEAD"
        >
          Compress
        </button>
        <button
          className={`view-btn ${showMergeLinks ? 'active' : ''}`}
          onClick={() => setShowMergeLinks(v => !v)}
        >
          Merge links
        </button>
        <button
          className={`view-btn ${showRefLabels ? 'active' : ''}`}
          onClick={() => setShowRefLabels(v => !v)}
        >
          Labels
        </button>
        {compressed && expandedLanes.size > 0 && (
          <button className="view-btn" onClick={() => setExpandedLanes(new Set())}>
            Collapse all
          </button>
        )}
        {focusedLane && (
          <button className="view-btn focused" onClick={() => setFocusedLane(null)}>
            ✕ {focusedLane}
          </button>
        )}
      </div>

      <svg ref={minimapRef} className="minimap"></svg>

      {laneMenu && (
        <div
          className="lane-menu"
          style={{ left: laneMenu.x, top: laneMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => { setFocusedLane(f => f === laneMenu.lane.name ? null : laneMenu.lane.name); setLaneMenu(null); }}>
            {focusedLane === laneMenu.lane.name ? 'Unfocus lane' : 'Focus this lane'}
          </button>
          <button onClick={() => { setExpandedLanes(prev => new Set(prev).add(laneMenu.lane.name)); setLaneMenu(null); }}>
            Expand all commits
          </button>
          <button onClick={() => { onViewFromBranch(laneMenu.lane.name); setLaneMenu(null); }}>
            View from this branch
          </button>
        </div>
      )}

      {hoveredCommit && (
        <div
          className="tooltip"
          style={{ left: tooltipPos.x + 15, top: tooltipPos.y + 15 }}
        >
          <div className="tooltip-hash">{hoveredCommit.short_id}</div>
          <div className="tooltip-message">{hoveredCommit.message}</div>
          <div className="tooltip-author">{hoveredCommit.author_name} · {hoveredCommit.lane_owner}</div>
          <div className="tooltip-time">{formatTime(hoveredCommit.timestamp)}</div>
          {(hoveredCommit.additions + hoveredCommit.deletions) > 0 && (
            <div className="tooltip-time">
              <span className="diff-add">+{hoveredCommit.additions}</span>{' '}
              <span className="diff-del">−{hoveredCommit.deletions}</span>
            </div>
          )}
          {hoveredCommit.branch_refs.length > 0 && (
            <div className="tooltip-branches">
              {hoveredCommit.branch_refs.map((ref, i) => (
                <span key={i} className={`tooltip-tag ${ref.is_tag ? 'tag-tag' : 'tag-branch'}`}>
                  {ref.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
