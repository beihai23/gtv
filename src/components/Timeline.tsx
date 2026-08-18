import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import type { GitData, BranchLane, CommitNode, CommitEdge, TimeGap } from '../types';

interface TimelineProps {
  data: GitData;
  onCommitClick: (commitId: string) => void;
  selectedCommitId: string | null;
  /** Increments when a repository is (re)opened — the only time the viewport resets. */
  resetKey: number;
  /** "View from this branch" (lane context menu). */
  onViewFromBranch: (branchName: string) => void;
  /** View options lifted to the app header. */
  compressed: boolean;
  showMergeLinks: boolean;
  showRefLabels: boolean;
  /** Increment to trigger "Fit to view" from outside. */
  fitSignal: number;
}

const LANE_HEIGHT = 80;
const MINIMAP_W = 280;
const MINIMAP_H = 170;

interface LaneMenu {
  x: number;
  y: number;
  lane: BranchLane;
}

interface BadgePill {
  name: string;
  is_tag: boolean;
}

interface BadgeSpec {
  c: CommitNode;
  names: BadgePill[];
  level: number;
}

function nodeRadius(c: CommitNode): number {
  const volume = c.additions + c.deletions;
  if (volume <= 0) return 7;
  return 7 + Math.min(7, Math.sqrt(volume) / 2.5);
}

export function Timeline({ data, onCommitClick, selectedCommitId, resetKey, onViewFromBranch, compressed, showMergeLinks, showRefLabels, fitSignal }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const minimapRef = useRef<SVGSVGElement>(null);
  const laneRailRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const resetKeyRef = useRef(-1);
  const [hoveredCommit, setHoveredCommit] = useState<CommitNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [laneMenu, setLaneMenu] = useState<LaneMenu | null>(null);
  /** Endpoints of the last plain-clicked edge; drives the highlight rings. */
  const [edgeHighlight, setEdgeHighlight] = useState<{ from: string; to: string } | null>(null);

  // View-local state (options themselves live in the app header)
  const [focusedLane, setFocusedLane] = useState<string | null>(null);
  const [expandedLanes, setExpandedLanes] = useState<Set<string>>(new Set());
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const sceneBoundsRef = useRef({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  /** Scene→minimap mapping, set during minimap draw; viewport rect reads it. */
  const minimapMapRef = useRef({ sx: 1, sy: 1, x0: 0, y0: 0 });

  const commitMap = useMemo(() => new Map(data.commits.map(c => [c.id, c])), [data]);
  const branchColorMap = useMemo(() => new Map(data.branches.map(b => [b.name, b.color])), [data]);

  // Reset view-local state when a different repository is opened.
  useEffect(() => {
    setFocusedLane(null);
    setExpandedLanes(new Set());
    setLaneMenu(null);
    setEdgeHighlight(null);
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
      const m = minimapMapRef.current;
      // screen = t * scene ; scene->mini = per-axis scale (non-uniform)
      const vx = (-t.x / t.k - m.x0) * m.sx;
      const vy = (-t.y / t.k - m.y0) * m.sy;
      const vw = (width / t.k) * m.sx;
      const vh = (height / t.k) * m.sy;
      d3.select(minimapRef.current).select('.mm-viewport')
        .attr('x', vx).attr('y', vy)
        .attr('width', Math.max(6, vw)).attr('height', Math.max(6, vh));
    };

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.005, 40])
      // Wheel events are handled by our own trackpad-friendly handler
      // (scroll = pan, pinch/ctrl = zoom); d3 only keeps drag-pan.
      .filter((event: Event) => event.type !== 'wheel')
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        transformRef.current = event.transform;
        g.attr('transform', event.transform.toString());
        cull();
        minimapViewport();
        updateRuler?.();
      });
    svg.call(zoom);
    zoomRef.current = zoom;

    /** Center the viewport on a scene point, keeping the current zoom. */
    const centerOn = (sx: number, sy: number) => {
      const t = transformRef.current;
      const next = d3.zoomIdentity
        .translate(width / 2 - sx * t.k, height / 2 - sy * t.k)
        .scale(t.k);
      svg.call(zoom.transform, next);
    };

    const allX = data.commits.map(c => c.x);
    const minX = Math.min(...allX, 0) - 180;
    const maxX = Math.max(...allX, 100) + 200;
    const minY = Math.min(...data.commits.map(c => c.y), 0) - LANE_HEIGHT;
    const maxY = Math.max(...data.commits.map(c => c.y), 0) + LANE_HEIGHT;
    sceneBoundsRef.current = { minX, maxX, minY, maxY };
    // No viewBox: the scene lives in plain pixel space and the zoom transform
    // owns all scaling. (viewBox + zoom double-scales, which made large repos
    // render microscopically small.)

    // --- sticky time ruler ---------------------------------------------------
    // Lives OUTSIDE the zoomable scene: pinned to the top of the canvas with
    // an opaque backdrop. The time→x mapping is piecewise: linear inside
    // committed ranges, with a steep ramp across each folded time gap (the
    // backend collapses >45-day empty stretches to a 120px axis break).
    // Ticks are generated for the VISIBLE time window only, so zooming in
    // refines their precision; ticks falling inside a folded gap are dropped.
    let updateRuler: (() => void) | null = null;
    if (data.commits.length > 1) {
      const tMin = Math.min(...data.commits.map(c => c.timestamp));
      const tMax = Math.max(...data.commits.map(c => c.timestamp));
      const xMinC = Math.min(...data.commits.map(c => c.x));
      const xMaxC = Math.max(...data.commits.map(c => c.x));
      const gaps = [...(data.time_gaps ?? [])].sort((a, b) => a.x_start - b.x_start);

      // Piecewise anchors: [tMin, g1.t_start, g1.t_end, ..., tMax] paired with
      // [xMin, g1.x_start, g1.x_end, ..., xMax]; linear between anchors.
      const times: number[] = [tMin];
      const xs: number[] = [xMinC];
      for (const gp of gaps) { times.push(gp.t_start, gp.t_end); xs.push(gp.x_start, gp.x_end); }
      times.push(tMax); xs.push(xMaxC);
      const lerpAnchors = (v: number, from: number[], to: number[]): number => {
        if (v <= from[0]) return to[0];
        for (let i = 1; i < from.length; i++) {
          if (v <= from[i]) {
            const d = from[i] - from[i - 1];
            return d <= 0 ? to[i] : to[i - 1] + (to[i] - to[i - 1]) * (v - from[i - 1]) / d;
          }
        }
        return to[to.length - 1];
      };
      const timeToX = (t: number) => lerpAnchors(t, times, xs);
      const xToTime = (x: number) => lerpAnchors(x, xs, times);
      const inGap = (t: number) => gaps.some(gp => t > gp.t_start && t < gp.t_end);

      const ruler = svg.append('g')
        .attr('class', 'time-ruler-sticky')
        .attr('pointer-events', 'none');
      ruler.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', width).attr('height', 26)
        .attr('fill', '#1a1a2e');
      ruler.append('line')
        .attr('x1', 0).attr('x2', width)
        .attr('y1', 26).attr('y2', 26)
        .attr('stroke', '#2c2c3e')
        .attr('stroke-width', 1);
      const axisG = ruler.append('g').attr('transform', 'translate(0, 26)');

      const pad2 = (n: number) => String(n).padStart(2, '0');
      const fmtDuration = (sec: number): string => {
        const days = sec / 86400;
        if (days < 90) return `${Math.max(1, Math.round(days))}d`;
        if (days < 730) return `${Math.round(days / 30.4)}mo`;
        return `${(days / 365.25).toFixed(1)}y`;
      };

      updateRuler = () => {
        const t = transformRef.current;
        // Visible time window (with margin), so ticks adapt to the zoom level.
        const vt0 = xToTime(-t.x / t.k - 100);
        const vt1 = xToTime((width - t.x) / t.k + 100);
        if (!(vt1 > vt0)) return;
        const shown = d3.scaleTime()
          .domain([new Date(vt0 * 1000), new Date(vt1 * 1000)])
          .ticks(Math.max(3, Math.floor(width / 150)))
          .filter(d => !inGap(d.getTime() / 1000));

        // Pick a precision strictly finer than the tightest tick gap, so two
        // adjacent labels can never read the same (e.g. four "2026-01" ticks).
        let minGapSec = Infinity;
        for (let i = 1; i < shown.length; i++) {
          minGapSec = Math.min(minGapSec, (shown[i].getTime() - shown[i - 1].getTime()) / 1000);
        }
        const fmtTick = (dt: Date): string => {
          const date = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
          if (minGapSec >= 250 * 86400) return `${dt.getFullYear()}`;
          if (minGapSec >= 25 * 86400) return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
          if (minGapSec >= 20 * 3600) return date;
          const time = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
          if (minGapSec >= 40 * 60) return `${date} ${time}`;
          return `${date} ${time}:${pad2(dt.getSeconds())}`;
        };

        const tick = axisG
          .selectAll<SVGGElement, Date>('.rtick')
          .data(shown, d => String(+d));
        const tickEnter = tick.enter().append('g').attr('class', 'rtick');
        tickEnter.append('line')
          .attr('y1', -5).attr('y2', 0)
          .attr('stroke', '#555');
        tickEnter.append('text')
          .attr('y', -8).attr('text-anchor', 'middle')
          .attr('fill', '#888').attr('font-size', '10px');
        const tickMerged = tickEnter.merge(tick);
        tickMerged.attr('transform', d => `translate(${t.applyX(timeToX(d.getTime() / 1000))},0)`);
        tickMerged.select('text').text(fmtTick);
        tick.exit().remove();

        // Axis-break markers: "// 45d" at the center of each folded gap.
        const brk = axisG
          .selectAll<SVGGElement, TimeGap>('.rbreak')
          .data(gaps, d => String(d.t_start));
        const brkEnter = brk.enter().append('g').attr('class', 'rbreak');
        brkEnter.append('text')
          .attr('y', -8).attr('text-anchor', 'middle')
          .attr('fill', '#a06a3a').attr('font-size', '9px');
        brkEnter.merge(brk)
          .attr('transform', d => `translate(${t.applyX((d.x_start + d.x_end) / 2)},0)`)
          .select('text')
          .text(d => `// ${fmtDuration(d.t_end - d.t_start)}`);
        brk.exit().remove();
      };
      updateRuler();
    }

    // --- folded-gap scene markers ---------------------------------------------
    // Low-key vertical dashed lines where the time axis is broken, so the
    // discontinuity is visible inside the graph itself.
    if (data.time_gaps && data.time_gaps.length > 0) {
      g.selectAll('.gap-break')
        .data(data.time_gaps)
        .enter()
        .append('line')
        .attr('class', 'gap-break')
        .attr('x1', (d: TimeGap) => (d.x_start + d.x_end) / 2)
        .attr('x2', (d: TimeGap) => (d.x_start + d.x_end) / 2)
        .attr('y1', minY)
        .attr('y2', maxY)
        .attr('stroke', '#a06a3a')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '6,5')
        .attr('opacity', 0.35);
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

    // --- lane chips: HTML overlay pinned to the left edge --------------------
    // Rendered OUTSIDE the svg as a frosted-glass rail on the highest z-layer,
    // so labels stay crisp and readable when the graph scrolls beneath them
    // (SVG-in-scene labels can't do backdrop blur). cull() repositions them on
    // every pan/zoom and thins them at heavy zoom-out.
    const rail = d3.select(laneRailRef.current);
    rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip')
      .data(data.branches, (d: BranchLane) => d.name)
      .join('div')
      .attr('class', 'lane-chip')
      .style('color', (d: BranchLane) => d.color)
      .style('border-color', (d: BranchLane) => d.color)
      .style('opacity', (d: BranchLane) => dimOthers(d.name) ? 0.25 : 1)
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
      return visibleIds.has(e.from) && visibleIds.has(e.to); // Branch/Merge endpoints are key nodes
    });

    // Edge direction (from the backend): from = child commit, to = parent.
    const edgePath = (d: CommitEdge): string => {
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
    };
    const isHotEdge = (d: CommitEdge) =>
      edgeHighlight !== null && edgeHighlight.from === d.from && edgeHighlight.to === d.to;

    g.selectAll('.edge')
      .data(visibleEdges)
      .enter()
      .append('path')
      .attr('class', 'edge')
      .attr('d', edgePath)
      .attr('fill', 'none')
      .attr('stroke', (d: CommitEdge) => {
        if (isHotEdge(d)) return '#FFD166';
        const from = commitMap.get(d.from);
        return from ? branchColorMap.get(from.lane_owner) ?? '#888' : '#888';
      })
      .attr('stroke-width', (d: CommitEdge) => {
        if (isHotEdge(d)) return 4;
        return d.edge_type === 'Direct' ? 2.5 : d.edge_type === 'Branch' ? 1.8 : 1.3;
      })
      .attr('opacity', (d: CommitEdge) => {
        if (isHotEdge(d)) return 1;
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

    // Invisible fat strokes on top: edges are 1.3-2.5px thin, so the clickable
    // area lives on a separate transparent path.
    //   click       -> highlight both endpoint commits
    //   ctrl/cmd+click -> jump to the parent end
    //   shift+click    -> jump to the child end
    const edgeHit = g.selectAll('.edge-hit')
      .data(visibleEdges)
      .enter()
      .append('path')
      .attr('class', 'edge-hit')
      .attr('d', edgePath)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(0,0,0,0)')
      .attr('stroke-width', 14)
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d: CommitEdge) => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) {
          const parent = commitMap.get(d.to);
          if (parent) centerOn(parent.x, parent.y);
        } else if (event.shiftKey) {
          const child = commitMap.get(d.from);
          if (child) centerOn(child.x, child.y);
        } else {
          setEdgeHighlight(h => (h && h.from === d.from && h.to === d.to ? null : { from: d.from, to: d.to }));
        }
      });
    edgeHit.append('title')
      .text('Click: highlight endpoints\nCtrl+Click: go to parent\nShift+Click: go to child');

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

    // edge-click highlight: amber rings around the two endpoint commits
    if (edgeHighlight) {
      nodes
        .filter((d: CommitNode) => d.id === edgeHighlight!.from || d.id === edgeHighlight!.to)
        .append('circle')
        .attr('r', (d: CommitNode) => nodeRadius(d) + 6)
        .attr('fill', 'none')
        .attr('stroke', '#FFD166')
        .attr('stroke-width', 2.5)
        .attr('pointer-events', 'none');
    }

    // NOTE: no SVG <title> on nodes — the custom HTML tooltip below covers
    // hover; a native title would show up as a second, redundant popup.

    // --- node labels (short id + message), greedily thinned per lane ---------
    // Labels on a lane are laid out left-to-right; a label is only drawn when
    // it clears the previous one, so dense regions degrade to every-Nth label
    // instead of an overlapping mess. The selected commit is always labelled.
    const labelVisible = (() => {
      const ok = new Set<string>();
      const lastX1 = new Map<string, number>();
      const byX = [...visibleCommits].sort((a, b) => a.x - b.x);
      for (const c of byX) {
        const x0 = c.x + nodeRadius(c) + 7;
        const w = Math.max(c.short_id.length * 6.6, Math.min(c.message.length, 30) * 5.8);
        const prev = lastX1.get(c.lane_owner);
        if (prev !== undefined && x0 < prev + 8 && c.id !== selectedCommitId) continue;
        lastX1.set(c.lane_owner, x0 + w);
        ok.add(c.id);
      }
      return ok;
    })();

    const labels = g.selectAll('.label')
      .data(visibleCommits.filter(c => labelVisible.has(c.id)))
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

    // --- ref badges, collision-resolved per lane ---------------------------
    // A commit shows at most two pills (first ref + "+N"). Pill groups that
    // would horizontally overlap a neighbour on the same lane are pushed to a
    // higher level; groups beyond MAX_LEVEL are dropped (their refs stay
    // reachable through the node tooltip and the CommitDetails panel).
    if (showRefLabels) {
      const pillW = (name: string) => name.length * 5.6 + 14;
      const LEVEL_H = 40;
      const MAX_LEVEL = 3;
      const specs: BadgeSpec[] = [];
      const lastX1 = new Map<string, number[]>();
      const withRefs = visibleCommits
        .filter(c => c.branch_refs.length > 0)
        .sort((a, b) => a.x - b.x);
      for (const c of withRefs) {
        const shown = c.branch_refs.slice(0, 2);
        const extra = c.branch_refs.length - shown.length;
        const names: BadgePill[] = shown.map(r => ({ name: r.name, is_tag: r.is_tag }));
        if (extra > 0) names.push({ name: `+${extra}`, is_tag: false });
        const width = Math.max(...names.map(n => pillW(n.name)));
        const x0 = c.x - width / 2;
        const edges = lastX1.get(c.lane_owner) ?? [];
        let level = 0;
        while (level <= MAX_LEVEL && edges[level] !== undefined && x0 < edges[level] + 8) level++;
        if (level > MAX_LEVEL) continue;
        edges[level] = c.x + width / 2;
        lastX1.set(c.lane_owner, edges);
        specs.push({ c, names, level });
      }
      const badgeGroups = g.selectAll('.ref-badges')
        .data(specs)
        .enter()
        .append('g')
        .attr('class', 'ref-badges')
        .attr('transform', s => `translate(${s.c.x}, ${s.c.y - nodeRadius(s.c) - 8 - s.level * LEVEL_H})`)
        .attr('opacity', s => laneOpacity(s.c.lane_owner));
      badgeGroups.each(function (s) {
        const grp = d3.select(this);
        grp.append('title').text(s.c.branch_refs.map(r => r.name).join('\n'));
        // Connector pin from the pill stack down to its commit node — without
        // it, badges lifted to higher levels look detached from their commit.
        const dropY = 8 + s.level * LEVEL_H;
        if (dropY > 6) {
          grp.append('line')
            .attr('x1', 0).attr('y1', 4)
            .attr('x2', 0).attr('y2', dropY)
            .attr('stroke', '#888')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '2,2')
            .attr('opacity', 0.65);
        }
        s.names.forEach((n, i) => {
          const w = pillW(n.name);
          const item = grp.append('g').attr('transform', `translate(${-w / 2}, ${-i * 18})`);
          item.append('rect')
            .attr('x', 0).attr('y', -13)
            .attr('width', w).attr('height', 16)
            .attr('rx', 8)
            .attr('fill', n.is_tag ? '#9C27B0' : n.name.startsWith('+') ? '#555' : branchColorMap.get(s.c.lane_owner) ?? '#4A90D9')
            .attr('opacity', 0.92);
          item.append('text')
            .attr('x', w / 2).attr('y', -2)
            .attr('text-anchor', 'middle')
            .attr('font-size', '9px')
            .attr('fill', '#fff')
            .text(n.name);
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

    // --- viewport culling: only elements inside (or near) the visible scene
    // rect stay in the render tree; everything else is display:none. Lane
    // labels get pinned to the view's left edge so they never scroll away.
    function cull() {
      const t = transformRef.current;
      const M = 240; // scene-px margin around the viewport
      const x0 = -t.x / t.k - M;
      const x1 = (width - t.x) / t.k + M;
      const y0 = -t.y / t.k - M;
      const y1 = (height - t.y) / t.k + M;
      const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

      g.selectAll<SVGGElement, CommitNode>('.node,.label')
        .style('display', d => (inView(d.x, d.y) ? null : 'none'));
      g.selectAll<SVGGElement, BadgeSpec>('.ref-badges')
        .style('display', d => (inView(d.c.x, d.c.y) ? null : 'none'));
      g.selectAll<SVGTextElement, CommitNode>('.fork-label,.merge-label')
        .style('display', d => (inView(d.x, d.y) ? null : 'none'));
      g.selectAll<SVGPathElement, CommitEdge>('.edge,.edge-hit')
        .style('display', d => {
          const a = commitMap.get(d.from);
          const b = commitMap.get(d.to);
          if (!a || !b) return 'none';
          return inView(a.x, a.y) || inView(b.x, b.y) ? null : 'none';
        });
      g.selectAll<SVGLineElement, TimeGap>('.gap-break')
        .style('display', d => {
          const x = (d.x_start + d.x_end) / 2;
          return x >= x0 && x <= x1 ? null : 'none';
        });
      g.selectAll<SVGLineElement, BranchLane>('.lane,.lane-bar')
        .style('display', d => {
          const y = d.lane_index * LANE_HEIGHT;
          return y >= y0 && y <= y1 ? null : 'none';
        });
      rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip')
        .style('display', d => {
          const y = d.lane_index * LANE_HEIGHT;
          if (y < y0 || y > y1) return 'none';
          // keep clear of the sticky ruler band
          const sy = y * t.k + t.y;
          if (sy < 34 || sy > height - 8) return 'none';
          // At heavy zoom-out lanes squeeze together; thin the pinned chips so
          // they never overlap on screen (every Nth lane keeps its label).
          const rowH = LANE_HEIGHT * t.k;
          if (rowH < 18 && d.lane_index % Math.ceil(18 / rowH) !== 0) return 'none';
          return null;
        })
        .style('top', d => `${d.lane_index * LANE_HEIGHT * t.k + t.y - 9}px`);
      g.selectAll<SVGGElement, { lane: BranchLane; hidden: number }>('.collapse-chip')
        .style('display', d => {
          const span = laneSpan.get(d.lane.lane_index);
          if (!span) return 'none';
          return inView((span.min + span.max) / 2, d.lane.lane_index * LANE_HEIGHT) ? null : 'none';
        });
    }

    // --- minimap ----------------------------------------------------------------------
    // Non-uniform scale: x and y stretch independently, so even an extremely
    // wide-flat scene (big repo, time-proportional x) fills the whole map.
    // Lanes render as activity bars spanning their commits; key commits are
    // bright dots. The map answers "where is the activity", not "where are
    // individual commits".
    if (minimapRef.current) {
      const mm = d3.select(minimapRef.current);
      mm.selectAll('*').remove();
      mm.attr('width', MINIMAP_W).attr('height', MINIMAP_H);
      const sceneW = Math.max(maxX - minX, 1);
      const sceneH = Math.max(maxY - minY, 1);
      const sx = MINIMAP_W / sceneW;
      const sy = MINIMAP_H / sceneH;
      minimapMapRef.current = { sx, sy, x0: minX, y0: minY };
      const mx = (x: number) => (x - minX) * sx;
      const my = (y: number) => (y - minY) * sy;

      for (const b of data.branches) {
        const span = laneSpan.get(b.lane_index);
        if (!span) continue;
        const y = my(b.lane_index * LANE_HEIGHT);
        mm.append('line')
          .attr('x1', mx(span.min))
          .attr('x2', Math.max(mx(span.max), mx(span.min) + 2))
          .attr('y1', y).attr('y2', y)
          .attr('stroke', b.color)
          .attr('stroke-width', 2.5)
          .attr('stroke-linecap', 'round')
          .attr('opacity', dimOthers(b.name) ? 0.15 : 0.75);
      }
      for (const c of data.commits) {
        if (!c.is_key) continue;
        mm.append('circle')
          .attr('cx', mx(c.x)).attr('cy', my(c.y))
          .attr('r', 1.8)
          .attr('fill', '#fff')
          .attr('opacity', 0.85);
      }

      // time anchors: oldest ↔ newest month
      const fmtMY = (ts: number) => {
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      };
      const tMin = Math.min(...data.commits.map(c => c.timestamp));
      const tMax = Math.max(...data.commits.map(c => c.timestamp));
      mm.append('text')
        .attr('x', 3).attr('y', MINIMAP_H - 4)
        .attr('font-size', '9px').attr('fill', '#777')
        .text(fmtMY(tMin));
      mm.append('text')
        .attr('x', MINIMAP_W - 3).attr('y', MINIMAP_H - 4)
        .attr('font-size', '9px').attr('fill', '#777')
        .attr('text-anchor', 'end')
        .text(fmtMY(tMax));

      mm.append('rect')
        .attr('class', 'mm-viewport')
        .attr('fill', 'rgba(125, 184, 240, 0.16)')
        .attr('stroke', '#8ec6ff')
        .attr('stroke-width', 1.5)
        .attr('rx', 2)
        .attr('pointer-events', 'none');

      // Click to jump; hold and drag to scrub the viewport across the map.
      const jump = (event: MouseEvent) => {
        const [px, py] = d3.pointer(event, minimapRef.current);
        centerOn(px / sx + minX, py / sy + minY);
      };
      mm.on('mousedown', (event: MouseEvent) => {
        event.preventDefault();
        jump(event);
        const move = (ev: MouseEvent) => jump(ev);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      mm.on('click', (event: MouseEvent) => event.stopPropagation());
    }

    // --- viewport: reset only when a repo was (re)opened ------------------------------
    const shouldReset = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (data.commits.length > 0 && shouldReset) {
      // Default view: readable 1x zoom, positioned on the newest commit
      // (HEAD when known) — latest activity sits right-of-center, its lane
      // vertically centered. Pan/zoom out from there, or use the minimap.
      const newest = data.commits.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      const target = data.commits.find(c => c.is_head) ?? newest;
      const k = 1;
      const t = d3.zoomIdentity
        .translate(width * 0.7 - target.x * k, height / 2 - target.y * k)
        .scale(k);
      svg.call(zoom.transform, t);
      transformRef.current = t;
    } else {
      svg.call(zoom.transform, transformRef.current);
    }
    minimapViewport();
  }, [data, onCommitClick, selectedCommitId, resetKey, compressed, showMergeLinks, showRefLabels, focusedLane, expandedLanes, hiddenCountByLane, visibleCommits, commitMap, branchColorMap, edgeHighlight]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  /** Fit the whole scene into the viewport (toolbar "Fit" button). */
  const fitToView = useCallback(() => {
    if (!svgRef.current || !zoomRef.current || !containerRef.current) return;
    const { minX, maxX, minY, maxY } = sceneBoundsRef.current;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;
    const sceneW = maxX - minX;
    const sceneH = maxY - minY;
    if (sceneW <= 0 || sceneH <= 0) return;
    const k = Math.min(width / sceneW, height / sceneH, 1) * 0.9;
    const t = d3.zoomIdentity
      .translate(width / 2 - (minX + sceneW / 2) * k, height / 2 - (minY + sceneH / 2) * k)
      .scale(k);
    d3.select(svgRef.current).call(zoomRef.current.transform, t);
  }, []);

  // "Fit" lives in the app header; fitSignal increments trigger it here.
  const fitSignalRef = useRef(fitSignal);
  useEffect(() => {
    if (fitSignalRef.current === fitSignal) return;
    fitSignalRef.current = fitSignal;
    fitToView();
  }, [fitSignal, fitToView]);

  // Trackpad-friendly wheel handling (Figma-style):
  //   two-finger scroll (plain wheel)  -> pan
  //   pinch (ctrlKey wheel) / cmd+wheel -> zoom around the cursor
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoom = zoomRef.current;
      if (!zoom) return;
      const t = transformRef.current;
      const unit = event.deltaMode === 1 ? 16 : 1; // Firefox line mode
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;

      let next: d3.ZoomTransform;
      if (event.ctrlKey || event.metaKey) {
        const rect = node.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const k2 = Math.min(40, Math.max(0.005, t.k * Math.exp(-dy * 0.0022)));
        const s = k2 / t.k;
        // keep the scene point under the cursor fixed on screen
        next = d3.zoomIdentity
          .translate(mx - s * (mx - t.x), my - s * (my - t.y))
          .scale(k2);
      } else {
        next = d3.zoomIdentity.translate(t.x - dx, t.y - dy).scale(t.k);
      }
      d3.select(node).call(zoom.transform, next);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div ref={containerRef} className="timeline-container" onClick={() => { setLaneMenu(null); setEdgeHighlight(null); }}>
      <svg ref={svgRef}></svg>
      <div className="lane-rail-blur"></div>
      <div ref={laneRailRef} className="lane-rail"></div>

      <div className="view-toolbar">
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
