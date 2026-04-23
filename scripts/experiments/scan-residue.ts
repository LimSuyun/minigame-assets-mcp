import sharp from "sharp";

async function scan(filePath: string): Promise<void> {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const target = [255, 0, 255];
  let totalOpaque = 0;
  let magentaResidue = 0;
  let nearMagenta = 0;
  let maxCluster = 0;

  const visited = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 250) continue;
      totalOpaque++;
      const dr = data[i] - target[0];
      const dg = data[i + 1] - target[1];
      const db = data[i + 2] - target[2];
      const dist = Math.sqrt(dr*dr + dg*dg + db*db);
      if (dist <= 80) { magentaResidue++; }
      if (dist <= 150) { nearMagenta++; }
    }
  }

  // Largest connected magenta island
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = y * width + x;
      if (visited[pos]) continue;
      const i = pos * 4;
      const a = data[i + 3];
      if (a < 250) continue;
      const dr = data[i] - target[0];
      const dg = data[i + 1] - target[1];
      const db = data[i + 2] - target[2];
      const dist = Math.sqrt(dr*dr + dg*dg + db*db);
      if (dist > 80) continue;
      // BFS
      const q = [pos];
      visited[pos] = 1;
      let size = 0;
      while (q.length) {
        const p = q.shift()!;
        size++;
        const px = p % width, py = (p - px) / width;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const np = ny * width + nx;
          if (visited[np]) continue;
          const ni = np * 4;
          if (data[ni+3] < 250) continue;
          const ndr = data[ni]-target[0], ndg = data[ni+1]-target[1], ndb = data[ni+2]-target[2];
          if (Math.sqrt(ndr*ndr+ndg*ndg+ndb*ndb) > 80) continue;
          visited[np] = 1;
          q.push(np);
        }
      }
      if (size > maxCluster) maxCluster = size;
    }
  }

  const pct = (x: number) => ((x / totalOpaque) * 100).toFixed(3);
  console.log(`\n── ${filePath}`);
  console.log(`  해상도         : ${width}×${height}`);
  console.log(`  불투명 픽셀    : ${totalOpaque.toLocaleString()}`);
  console.log(`  마젠타 잔류    : ${magentaResidue.toLocaleString()} (${pct(magentaResidue)}%) — 거리 ≤ 80`);
  console.log(`  근접 마젠타    : ${nearMagenta.toLocaleString()} (${pct(nearMagenta)}%) — 거리 ≤ 150`);
  console.log(`  최대 잔류 클러스터: ${maxCluster.toLocaleString()} 픽셀`);
}

(async () => {
  await scan("./test-output/walk-compare/base.png");
  await scan("./test-output/walk-compare/base_gpt-image-1.png");
})();
