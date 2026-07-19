// Hex grid maths — "odd-r" offset layout: pointy-top hexes laid out in rows,
// with odd-numbered rows pushed half a hex to the right. Cells are addressed by
// plain (col,row) integers, which keeps the rest of the game simple; the cube
// conversion below is only used for measuring true hex distance.
(function (global) {
  // Centre of a cell in pixels. `size` is centre->corner (the hex "radius").
  function centre(col, row, size) {
    const w = Math.sqrt(3) * size; // full hex width
    const x = w * (col + 0.5 * (row & 1)) + w / 2;
    const y = size * 1.5 * row + size;
    return { x, y };
  }

  // Overall pixel bounds of a cols x rows grid.
  function gridSize(cols, rows, size) {
    const w = Math.sqrt(3) * size;
    return { width: w * (cols + 0.5), height: size * 1.5 * (rows - 1) + size * 2 };
  }

  // The 6 corners of a pointy-top hex, as an SVG points string.
  function corners(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(`${(cx + size * Math.cos(a)).toFixed(2)},${(cy + size * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
  }

  // Neighbour offsets differ per row parity in an offset layout.
  const EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
  const ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

  function neighbors(col, row) {
    const d = row & 1 ? ODD : EVEN;
    return d.map(([dc, dr]) => ({ col: col + dc, row: row + dr }));
  }

  function toCube(col, row) {
    const x = col - (row - (row & 1)) / 2;
    const z = row;
    return { x, y: -x - z, z };
  }

  // True hex distance in steps.
  function distance(a, b) {
    const A = toCube(a.col, a.row);
    const B = toCube(b.col, b.row);
    return (Math.abs(A.x - B.x) + Math.abs(A.y - B.y) + Math.abs(A.z - B.z)) / 2;
  }

  // Nearest cell to a pixel point, or null if it's outside every hex.
  function cellAt(px, py, cols, rows, size) {
    let best = null;
    let bestD = Infinity;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const c = centre(col, row, size);
        const d = (c.x - px) ** 2 + (c.y - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { col, row };
        }
      }
    }
    // only count it as a hit if the point is actually inside that hex's radius
    return best && bestD <= size * size ? best : null;
  }

  global.Hex = { centre, gridSize, corners, neighbors, distance, cellAt };
})(window);
