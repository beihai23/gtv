import { useRef, useEffect, useCallback, useState } from 'react';
import * as d3 from 'd3';
import type { GitData, BranchLane, CommitNode, CommitEdge } from '../types';

interface TimelineProps {
  data: GitData;
  onCommitClick: (commitId: string) => void;
  selectedCommitId: string | null;
}

const NODE_RADIUS = 8;
const LANE_HEIGHT = 80;

export function Timeline({ data, onCommitClick, selectedCommitId }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const [hoveredCommit, setHoveredCommit] = useState<CommitNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const commitMap = new Map(data.commits.map((c: CommitNode) => [c.id, c]));
  const branchColorMap = new Map(data.branches.map((b: BranchLane) => [b.name, b.color]));

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.01, 500])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        transformRef.current = event.transform;
        g.attr('transform', event.transform.toString());
      });

    svg.call(zoom);

    const minX = Math.min(...data.commits.map((c: CommitNode) => c.x), 0) - 180;
    const maxX = Math.max(...data.commits.map((c: CommitNode) => c.x), 1000) + 200;
    const minY = Math.min(...data.commits.map((c: CommitNode) => c.y), 0) - LANE_HEIGHT;
    const maxY = Math.max(...data.commits.map((c: CommitNode) => c.y), 0) + LANE_HEIGHT;

    svg.attr('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);

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
      .attr('opacity', 0.3);

    // Branch bars: a solid rounded bar spanning each lane's own commits
    // (the gmaster "select the bar" element — clickable in P3).
    const laneSpan = new Map<number, { min: number; max: number }>();
    for (const c of data.commits) {
      const span = laneSpan.get(c.lane) ?? { min: c.x, max: c.x };
      span.min = Math.min(span.min, c.x);
      span.max = Math.max(span.max, c.x);
      laneSpan.set(c.lane, span);
    }
    g.selectAll('.lane-bar')
      .data(data.branches.filter((b: BranchLane) => laneSpan.has(b.lane_index)))
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
      .attr('opacity', 0.55);

    // Lane name labels pinned to the left edge of the scene.
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
      .text((d: BranchLane) => d.name);

    g.selectAll('.edge')
      .data(data.edges)
      .enter()
      .append('path')
      .attr('class', 'edge')
      .attr('d', (d: CommitEdge) => {
        const from = commitMap.get(d.from);
        const to = commitMap.get(d.to);
        if (!from || !to) return '';

        if (d.edge_type === 'Direct') {
          return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
        } else if (d.edge_type === 'Merge') {
          const midX = (from.x + to.x) / 2;
          return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
        } else {
          const midX = (from.x + to.x) / 2;
          const offset = from.lane < to.lane ? -20 : 20;
          return `M ${from.x} ${from.y} C ${midX} ${from.y + offset}, ${midX} ${to.y - offset}, ${to.x} ${to.y}`;
        }
      })
      .attr('fill', 'none')
      .attr('stroke', '#888')
      .attr('stroke-width', 2);

    const nodes = g.selectAll('.node')
      .data(data.commits)
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y})`)
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
      .on('mouseleave', () => {
        setHoveredCommit(null);
      });

    nodes.append('circle')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d: CommitNode) => branchColorMap.get(d.lane_owner) ?? '#4A90D9')
      .attr('stroke', (d: CommitNode) => d.id === selectedCommitId ? '#fff' : 'transparent')
      .attr('stroke-width', (d: CommitNode) => d.id === selectedCommitId ? 3 : 0);

    // HEAD marker: white ring + green label above the node.
    const headNodes = nodes.filter((d: CommitNode) => d.is_head);
    headNodes.append('circle')
      .attr('r', NODE_RADIUS + 5)
      .attr('fill', 'none')
      .attr('stroke', '#4CAF50')
      .attr('stroke-width', 2);
    headNodes.append('text')
      .attr('y', -NODE_RADIUS - 10)
      .attr('font-size', '10px')
      .attr('font-weight', 'bold')
      .attr('fill', '#4CAF50')
      .attr('text-anchor', 'middle')
      .text('HEAD');

    nodes.append('title')
      .text((d: CommitNode) => `${d.short_id}\n${d.message}\n${d.author_name}\n${formatTime(d.timestamp)}`);

    const labels = g.selectAll('.label')
      .data(data.commits)
      .enter()
      .append('g')
      .attr('class', 'label')
      .attr('transform', (d: CommitNode) => `translate(${d.x + 15}, ${d.y - 5})`);

    labels.append('text')
      .attr('font-size', '11px')
      .attr('fill', '#ccc')
      .text((d: CommitNode) => d.short_id);

    labels.append('text')
      .attr('font-size', '10px')
      .attr('fill', '#888')
      .attr('y', 12)
      .text((d: CommitNode) => d.message.length > 30 ? d.message.slice(0, 30) + '...' : d.message);

    g.selectAll('.fork-label')
      .data(data.commits.filter((c: CommitNode) => c.fork_branch_name))
      .enter()
      .append('g')
      .attr('class', 'fork-label')
      .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y - 18})`)
      .append('text')
      .attr('font-size', '9px')
      .attr('fill', '#4A90D9')
      .attr('text-anchor', 'middle')
      .text((d: CommitNode) => d.fork_branch_name || '');

    g.selectAll('.merge-label')
      .data(data.commits.filter((c: CommitNode) => c.merge_branch_name))
      .enter()
      .append('g')
      .attr('class', 'merge-label')
      .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y + 28})`)
      .append('text')
      .attr('font-size', '9px')
      .attr('fill', '#E91E63')
      .attr('text-anchor', 'middle')
      .text((d: CommitNode) => d.merge_branch_name || '');

    const latestCommit = data.commits[data.commits.length - 1];
    if (latestCommit) {
      // Start with a reasonable scale focused on the timeline, not fitting everything
      const initialScale = 1.0;
      const translateX = width / 2 - latestCommit.x * initialScale;
      const translateY = height / 2;
      
      const initialTransform = d3.zoomIdentity
        .translate(translateX, translateY)
        .scale(initialScale);
      
      svg.call(zoom.transform, initialTransform);
      transformRef.current = initialTransform;
    }

  }, [data, onCommitClick, selectedCommitId]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  return (
    <div ref={containerRef} className="timeline-container">
      <svg ref={svgRef}></svg>
      {hoveredCommit && (
        <div 
          className="tooltip"
          style={{
            left: tooltipPos.x + 15,
            top: tooltipPos.y + 15,
          }}
        >
          <div className="tooltip-hash">{hoveredCommit.short_id}</div>
          <div className="tooltip-message">{hoveredCommit.message}</div>
          <div className="tooltip-author">{hoveredCommit.author_name} · {hoveredCommit.lane_owner}</div>
          <div className="tooltip-time">{formatTime(hoveredCommit.timestamp)}</div>
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
