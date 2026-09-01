/* global UTIF */
importScripts("static/vendor/UTIF.min.js");

const COMPONENT = {dapi: 2, nk: 1, tumor: 0};

function postProgress(phase, progress) {
  postMessage({type: "progress", phase, progress});
}

async function decode(buffer, extension, channel) {
  extension = extension.toLowerCase();
  if (extension === ".tif" || extension === ".tiff") {
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error("TIFF 中没有可读取的图像");
    const ifd = ifds[0];
    if ((ifd["t273"] || []).length > 1 && ifds.length > 1) {
      throw new Error("暂不支持多页 TIFF 或 Z-stack");
    }
    UTIF.decodeImage(buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const output = new Uint8Array(ifd.width * ifd.height);
    const component = COMPONENT[channel];
    for (let i = 0, j = component; i < output.length; i++, j += 4) output[i] = rgba[j];
    return {data: output, width: ifd.width, height: ifd.height};
  }
  const blob = new Blob([buffer], {type: extension === ".png" ? "image/png" : "image/jpeg"});
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", {willReadFrequently: true});
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  const output = new Uint8Array(canvas.width * canvas.height);
  const component = COMPONENT[channel];
  for (let i = 0, j = component; i < output.length; i++, j += 4) output[i] = rgba[j];
  return {data: output, width: canvas.width, height: canvas.height};
}

function boxBlur(input, width, height, radius) {
  radius = Math.max(0, Math.round(radius));
  if (!radius) return input;
  const horizontal = new Uint8Array(input.length);
  const output = new Uint8Array(input.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += input[row + Math.max(0, Math.min(width - 1, k))];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = Math.round(sum / span);
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum += input[row + addX] - input[row + removeX];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[Math.max(0, Math.min(height - 1, k)) * width + x];
    for (let y = 0; y < height; y++) {
      output[y * width + x] = Math.round(sum / span);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }
  return output;
}

function otsuThreshold(data) {
  const histogram = new Uint32Array(256);
  for (const value of data) {
    if (value > 0) histogram[value]++;
  }
  return otsuHistogramThreshold(histogram);
}

function otsuHistogramThreshold(histogram) {
  let total = 0, sum = 0;
  for (let value = 1; value < histogram.length; value++) {
    total += histogram[value];
    sum += value * histogram[value];
  }
  if (!total) return 255;
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, best = 0;
  for (let value = 1; value < histogram.length; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = value; }
  }
  return best;
}

function thresholdMask(data, params) {
  const mask = new Uint8Array(data.length);
  if (params.threshold_mode === "auto") {
    const requestedFactor=Number(params.auto_threshold_factor ?? 1);
    const factor=Number.isFinite(requestedFactor)?Math.min(1.5,Math.max(0.5,requestedFactor)):1;
    const threshold = Math.max(0, Math.min(255, Math.round(otsuThreshold(data) * factor)));
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= threshold ? 1 : 0;
  } else {
    const low = Math.max(0, Number(params.threshold_low));
    const high = Math.min(255, Number(params.threshold_high));
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= low && data[i] <= high ? 1 : 0;
  }
  return mask;
}

function scaleBarRegion(data,width,height) {
  const x0=Math.floor(width*.92),y0=Math.floor(height*.98);
  const minRun=Math.max(8,Math.floor(width*.025));
  for(let y=y0;y<height;y++){
    let run=0;
    for(let x=x0;x<width;x++){
      run=data[y*width+x]>=240?run+1:0;
      if(run>=minRun)return{x0,y0,x1:width-1,y1:height-1};
    }
  }
  return null;
}

function clearRegion(mask,region,width) {
  if(!region)return mask;
  for(let y=region.y0;y<=region.y1;y++)mask.fill(0,y*width+region.x0,y*width+region.x1+1);
  return mask;
}

function opening(mask, width, height, iterations) {
  iterations = Math.max(0, Math.min(2, Math.round(iterations)));
  let current = mask;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const eroded = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      let index = y * width + 1;
      for (let x = 1; x < width - 1; x++, index++) {
        eroded[index] = current[index] && current[index - 1] && current[index + 1] &&
          current[index - width] && current[index + width] ? 1 : 0;
      }
    }
    const dilated = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      let index = y * width + 1;
      for (let x = 1; x < width - 1; x++, index++) {
        dilated[index] = eroded[index] || eroded[index - 1] || eroded[index + 1] ||
          eroded[index - width] || eroded[index + width] ? 1 : 0;
      }
    }
    current = dilated;
  }
  return current;
}

function distanceTransform(mask, width, height) {
  const max = 65530;
  const distance = new Uint16Array(mask.length);
  for (let i = 0; i < mask.length; i++) distance[i] = mask[i] ? max : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let best = distance[i];
      if (x) best = Math.min(best, distance[i - 1] + 3);
      if (y) best = Math.min(best, distance[i - width] + 3);
      if (x && y) best = Math.min(best, distance[i - width - 1] + 4);
      if (x < width - 1 && y) best = Math.min(best, distance[i - width + 1] + 4);
      distance[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let best = distance[i];
      if (x < width - 1) best = Math.min(best, distance[i + 1] + 3);
      if (y < height - 1) best = Math.min(best, distance[i + width] + 3);
      if (x < width - 1 && y < height - 1) best = Math.min(best, distance[i + width + 1] + 4);
      if (x && y < height - 1) best = Math.min(best, distance[i + width - 1] + 4);
      distance[i] = best;
    }
  }
  return distance;
}

function lineSaddle(distance, width, first, second) {
  const steps = Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));
  if (!steps) return Math.min(first.distance, second.distance);
  let saddle = Math.min(first.distance, second.distance);
  for (let step = 1; step < steps; step++) {
    const ratio = step / steps;
    const x = Math.round(first.x + (second.x - first.x) * ratio);
    const y = Math.round(first.y + (second.y - first.y) * ratio);
    saddle = Math.min(saddle, distance[y * width + x]);
  }
  return saddle;
}

function selectSeeds(mask, distance, width, height, minDistance) {
  const candidates = [];
  for (let y = 1; y < height - 1; y++) {
    let i = y * width + 1;
    for (let x = 1; x < width - 1; x++, i++) {
      const d = distance[i];
      if (!mask[i] || d < 3) continue;
      if (d >= distance[i - 1] && d >= distance[i + 1] &&
          d >= distance[i - width] && d >= distance[i + width] &&
          d >= distance[i - width - 1] && d >= distance[i - width + 1] &&
          d >= distance[i + width - 1] && d >= distance[i + width + 1]) {
        candidates.push({index: i, x, y, distance: d});
      }
    }
  }
  candidates.sort((a, b) => b.distance - a.distance);
  const cell = Math.max(1, minDistance);
  const grid = new Map();
  const selected = [];
  let highestSelectedDistance = 0;
  for (const candidate of candidates) {
    const gx = Math.floor(candidate.x / cell), gy = Math.floor(candidate.y / cell);
    const searchRadius = Math.ceil(Math.max(
      minDistance,
      1.5 * (highestSelectedDistance + candidate.distance) / 3
    ) / cell);
    let blocked = false;
    for (let oy = -searchRadius; oy <= searchRadius && !blocked; oy++) {
      for (let ox = -searchRadius; ox <= searchRadius && !blocked; ox++) {
        for (const seed of grid.get(`${gx + ox},${gy + oy}`) || []) {
          const adaptiveDistance = Math.max(
            minDistance,
            1.5 * (seed.distance + candidate.distance) / 3
          );
          const separation = (seed.x - candidate.x) ** 2 + (seed.y - candidate.y) ** 2;
          if (separation < adaptiveDistance ** 2) {
            const prominence = Math.min(seed.distance, candidate.distance) -
              lineSaddle(distance, width, seed, candidate);
            if (prominence < minDistance) blocked = true;
          }
        }
      }
    }
    if (!blocked) {
      selected.push(candidate);
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(candidate);
      highestSelectedDistance = Math.max(highestSelectedDistance, candidate.distance);
    }
  }
  return selected;
}

function floodLabels(mask, width, height, seeds) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  seeds.forEach((seed, index) => {
    labels[seed.index] = index + 1;
    queue[tail++] = seed.index;
  });
  while (head < tail) {
    const index = queue[head++];
    const label = labels[index];
    const x = index % width;
    const neighbours = [index - width, index + width];
    if (x) neighbours.push(index - 1);
    if (x < width - 1) neighbours.push(index + 1);
    for (const next of neighbours) {
      if (next >= 0 && next < mask.length && mask[next] && !labels[next]) {
        labels[next] = label;
        queue[tail++] = next;
      }
    }
  }
  return labels;
}

function convexHullArea(corners, stride) {
  const points=[...corners].map(key=>({x:key%stride,y:Math.floor(key/stride)}))
    .sort((left,right)=>left.x-right.x||left.y-right.y);
  if(points.length<3)return 0;
  const cross=(origin,left,right)=>(left.x-origin.x)*(right.y-origin.y)-(left.y-origin.y)*(right.x-origin.x);
  const half=[];
  for(const point of points){
    while(half.length>=2&&cross(half[half.length-2],half[half.length-1],point)<=0)half.pop();
    half.push(point);
  }
  const lowerLength=half.length;
  for(let index=points.length-2;index>0;index--){
    const point=points[index];
    while(half.length>lowerLength&&cross(half[half.length-2],half[half.length-1],point)<=0)half.pop();
    half.push(point);
  }
  let twiceArea=0;
  for(let index=0;index<half.length;index++){
    const next=half[(index+1)%half.length];
    twiceArea+=half[index].x*next.y-half[index].y*next.x;
  }
  return Math.abs(twiceArea)/2;
}

function regionDetections(labels, width, height, params) {
  let maxLabel = 0;
  for (const label of labels) if (label > maxLabel) maxLabel = label;
  const area = new Uint32Array(maxLabel + 1);
  const sumX = new Float64Array(maxLabel + 1);
  const sumY = new Float64Array(maxLabel + 1);
  const perimeter = new Uint32Array(maxLabel + 1);
  const boundaryCorners = new Array(maxLabel + 1);
  const cornerStride=width+1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, label = labels[i];
      if (!label) continue;
      area[label]++; sumX[label] += x; sumY[label] += y;
      const left=!x||labels[i-1]!==label,right=x===width-1||labels[i+1]!==label;
      const top=!y||labels[i-width]!==label,bottom=y===height-1||labels[i+width]!==label;
      if(left)perimeter[label]++;if(right)perimeter[label]++;
      if(top)perimeter[label]++;if(bottom)perimeter[label]++;
      if(left||right||top||bottom){
        const corners=boundaryCorners[label]||(boundaryCorners[label]=new Set());
        corners.add(y*cornerStride+x);corners.add(y*cornerStride+x+1);
        corners.add((y+1)*cornerStride+x);corners.add((y+1)*cornerStride+x+1);
      }
    }
  }
  const detections = [];
  for (let label = 1; label <= maxLabel; label++) {
    if (!area[label]) continue;
    const circularity = Math.min(1, 4 * Math.PI * area[label] / Math.max(1, perimeter[label] ** 2));
    const hullArea=convexHullArea(boundaryCorners[label]||[],cornerStride);
    const solidity=Math.min(1,area[label]/Math.max(1,hullArea));
    const minSolidity=Math.min(1,Math.max(0,Number(params.min_solidity)||0));
    if (area[label] < params.min_area_px || area[label] > params.max_area_px ||
        circularity < params.min_circularity || circularity > params.max_circularity ||
        solidity < minSolidity) continue;
    detections.push({
      id: `auto-${detections.length + 1}`,
      _label: label,
      x: sumX[label] / area[label],
      y: sumY[label] / area[label],
      area_px: area[label],
      radius: Math.sqrt(area[label] / Math.PI),
      circularity,
      solidity,
      manual: false,
      deleted: false,
    });
  }
  return detections;
}

function attachMaskRuns(labels, width, height, detections) {
  const byLabel = new Map();
  for (const detection of detections) {
    detection.runs = [];
    byLabel.set(detection._label, detection);
  }
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const label = labels[y * width + x];
      const start = x;
      x++;
      while (x < width && labels[y * width + x] === label) x++;
      const detection = byLabel.get(label);
      if (detection) detection.runs.push(y, start, x - 1);
    }
  }
  for (const detection of detections) delete detection._label;
}

function median(values) {
  if(!values.length)return 0;
  values.sort((a,b)=>a-b);
  const middle=Math.floor(values.length/2);
  return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
}

function nucleusOwners(nuclei,width,height) {
  const owners=new Uint16Array(width*height);
  nuclei.forEach((nucleus,index)=>{
    const label=index+1;
    if(nucleus.runs?.length){
      for(let run=0;run<nucleus.runs.length;run+=3){
        const y=nucleus.runs[run],start=Math.max(0,nucleus.runs[run+1]),end=Math.min(width-1,nucleus.runs[run+2]);
        if(y<0||y>=height)continue;
        for(let x=start;x<=end;x++)owners[y*width+x]=label;
      }
      return;
    }
    const radius=Math.max(2,Number(nucleus.radius)||8),x0=Math.max(0,Math.floor(nucleus.x-radius)),x1=Math.min(width-1,Math.ceil(nucleus.x+radius));
    const y0=Math.max(0,Math.floor(nucleus.y-radius)),y1=Math.min(height-1,Math.ceil(nucleus.y+radius)),radius2=radius*radius;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if((x-nucleus.x)**2+(y-nucleus.y)**2<=radius2)owners[y*width+x]=label;
  });
  return owners;
}

function connectedSignalRuns(mask,width,height,offsetX,offsetY,minBlock) {
  const visited=new Uint8Array(mask.length),accepted=new Uint8Array(mask.length),queue=[];
  let acceptedPixels=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const start=y*width+x;
    if(!mask[start]||visited[start])continue;
    const component=[];queue.length=0;queue.push(start);visited[start]=1;
    for(let head=0;head<queue.length;head++){
      const index=queue[head],px=index%width,py=Math.floor(index/width);component.push(index);
      for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
        if(!ox&&!oy)continue;
        const nx=px+ox,ny=py+oy;
        if(nx<0||nx>=width||ny<0||ny>=height)continue;
        const next=ny*width+nx;
        if(mask[next]&&!visited[next]){visited[next]=1;queue.push(next);}
      }
    }
    if(component.length<minBlock)continue;
    acceptedPixels+=component.length;
    for(const index of component)accepted[index]=1;
  }
  const runs=[];
  for(let y=0;y<height;y++){
    let x=0;
    while(x<width){
      while(x<width&&!accepted[y*width+x])x++;
      if(x>=width)break;
      const start=x++;
      while(x<width&&accepted[y*width+x])x++;
      runs.push(y+offsetY,start+offsetX,x-1+offsetX);
    }
  }
  return{runs,pixels:acceptedPixels};
}

function robustPositivity(signal,width,height,nucleus,nucleusIndex,nuclei,owners,params,pixelSizeUm,scaleBar,options={}) {
  const legacyPx=Math.max(0,Number(params.ring_radius_px)||0);
  const ringUm=params.ring_radius_um;
  const ringPx=ringUm!==null&&ringUm!==undefined&&ringUm!==""&&Number.isFinite(Number(ringUm))&&Number(ringUm)>=0
    ? Number(ringUm)/pixelSizeUm:legacyPx;
  const outerRadius=Math.max(2,Number(nucleus.radius)||8)+ringPx;
  const bgGap=.75/pixelSizeUm,bgWidth=3/pixelSizeUm,bgStart=outerRadius+bgGap,bgEnd=bgStart+bgWidth;
  const x0=Math.max(0,Math.floor(nucleus.x-bgEnd)),x1=Math.min(width-1,Math.ceil(nucleus.x+bgEnd));
  const y0=Math.max(0,Math.floor(nucleus.y-bgEnd)),y1=Math.min(height-1,Math.ceil(nucleus.y+bgEnd));
  const outer2=outerRadius**2,bgStart2=bgStart**2,bgEnd2=bgEnd**2,ownLabel=nucleusIndex+1;
  const neighbours=nuclei.filter((other,index)=>index!==nucleusIndex&&Math.hypot(other.x-nucleus.x,other.y-nucleus.y)<bgEnd+(Number(other.radius)||8));
  const candidate=[],background=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    if(scaleBar&&x>=scaleBar.x0&&y>=scaleBar.y0)continue;
    const dx=x-nucleus.x,dy=y-nucleus.y,d2=dx*dx+dy*dy,index=y*width+x,owner=owners[index];
    if(d2<=outer2){
      if(owner&&owner!==ownLabel)continue;
      if(neighbours.some(other=>(x-other.x)**2+(y-other.y)**2<d2))continue;
      candidate.push(index);
    }else if(d2>=bgStart2&&d2<=bgEnd2&&!owner&&
      !neighbours.some(other=>(x-other.x)**2+(y-other.y)**2<d2))background.push(signal[index]);
  }
  const fallbackBackground=background.length?background:candidate
    .map(index=>signal[index])
    .sort((a,b)=>a-b)
    .slice(0,Math.max(1,Math.ceil(candidate.length*.25)));
  const baseline=median(fallbackBackground);
  const mad=median(fallbackBackground.map(value=>Math.abs(value-baseline)));
  const residualHistogram=new Uint32Array(256);
  for(const index of candidate){
    const residual=Math.max(0,Math.min(255,Math.round(signal[index]-baseline)));
    if(residual>0)residualHistogram[residual]++;
  }
  const userMinimum=Math.max(0,Number(params.signal_threshold)||0);
  const madThreshold=Math.max(0,(Number(params.signal_mad_multiplier)||0)*1.4826*mad);
  const autoThreshold=Math.max(0,Number(options.autoThreshold)||0);
  if(options.histogramOnly)return{
    residualHistogram,background:baseline,mad,userMinimum,madThreshold,
    candidatePixels:candidate.length,ringRadiusPx:ringPx,
  };
  const delta=Math.max(userMinimum,madThreshold,autoThreshold);
  const signalX0=Math.max(0,Math.floor(nucleus.x-outerRadius)),signalX1=Math.min(width-1,Math.ceil(nucleus.x+outerRadius));
  const signalY0=Math.max(0,Math.floor(nucleus.y-outerRadius)),signalY1=Math.min(height-1,Math.ceil(nucleus.y+outerRadius));
  const localWidth=signalX1-signalX0+1,localHeight=signalY1-signalY0+1;
  const positiveMask=new Uint8Array(localWidth*localHeight);
  for(const index of candidate)if(signal[index]-baseline>=delta){
    const x=index%width,y=Math.floor(index/width);
    positiveMask[(y-signalY0)*localWidth+x-signalX0]=1;
  }
  const minBlock=Math.max(1,Math.ceil((Number(params.min_signal_block_um2)||0)/(pixelSizeUm**2)));
  const accepted=connectedSignalRuns(positiveMask,localWidth,localHeight,signalX0,signalY0,minBlock);
  return{
    fraction:candidate.length?accepted.pixels/candidate.length:0,
    background:baseline,mad,threshold:baseline+delta,
    delta,userMinimum,madThreshold,autoThreshold,
    runs:accepted.runs,areaPx:accepted.pixels,ringRadiusPx:ringPx,
  };
}

function nucleiMayShareCell(nuclei,pixelSizeUm) {
  if(nuclei.length<=1)return true;
  const referenceLimitPx=nuclei.length===2?55:nuclei.length===3?70:0;
  if(!referenceLimitPx)return false;
  const limitPx=referenceLimitPx*.218/Math.max(.001,Number(pixelSizeUm)||.218);
  for(let left=0;left<nuclei.length;left++)for(let right=left+1;right<nuclei.length;right++){
    if(Math.hypot(nuclei[left].x-nuclei[right].x,nuclei[left].y-nuclei[right].y)>limitPx+1e-9)return false;
  }
  return true;
}

function markerCellInstances(positiveNuclei,width,height,target,params,pixelSizeUm=.218) {
  if(!positiveNuclei.length)return[];
  const parent=positiveNuclei.map((_,index)=>index);
  const find=index=>{
    while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}
    return index;
  };
  const join=(left,right)=>{
    left=find(left);right=find(right);
    if(left!==right)parent[right]=left;
  };
  const rows=new Map();
  positiveNuclei.forEach((item,index)=>{
    const runs=item.signal.runs||[];
    for(let run=0;run<runs.length;run+=3){
      const y=runs[run],segment={start:runs[run+1],end:runs[run+2],index};
      if(!rows.has(y))rows.set(y,[]);
      rows.get(y).push(segment);
    }
  });
  for(const [y,current] of rows){
    current.sort((left,right)=>left.start-right.start||left.end-right.end);
    let leader=current[0],reach=leader?.end??-1;
    for(let index=1;index<current.length;index++){
      const right=current[index];
      if(right.start<=reach+1){join(leader.index,right.index);reach=Math.max(reach,right.end);}
      else{leader=right;reach=right.end;}
    }
    const previous=rows.get(y-1);
    if(!previous)continue;
    previous.sort((left,right)=>left.start-right.start||left.end-right.end);
    let first=0;
    for(const segment of current){
      while(first<previous.length&&previous[first].end<segment.start-1)first++;
      for(let index=first;index<previous.length&&previous[index].start<=segment.end+1;index++){
        join(segment.index,previous[index].index);
      }
    }
  }
  const grouped=new Map();
  positiveNuclei.forEach((item,index)=>{
    const root=find(index);
    if(!grouped.has(root))grouped.set(root,[]);
    grouped.get(root).push(item);
  });
  const mergeRuns=items=>{
    const byRow=new Map();
    for(const item of items){
      const runs=item.signal.runs||[];
      for(let run=0;run<runs.length;run+=3){
        const y=runs[run];
        if(!byRow.has(y))byRow.set(y,[]);
        byRow.get(y).push([runs[run+1],runs[run+2]]);
      }
    }
    const merged=[];
    for(const y of [...byRow.keys()].sort((left,right)=>left-right)){
      const intervals=byRow.get(y).sort((left,right)=>left[0]-right[0]||left[1]-right[1]);
      let [start,end]=intervals[0];
      for(let index=1;index<intervals.length;index++){
        const [nextStart,nextEnd]=intervals[index];
        if(nextStart<=end+1)end=Math.max(end,nextEnd);
        else{merged.push(y,start,end);start=nextStart;end=nextEnd;}
      }
      merged.push(y,start,end);
    }
    return merged;
  };
  const overlapLength=(start,end,intervals)=>{
    let overlap=0;
    for(const [otherStart,otherEnd] of intervals||[]){
      if(otherEnd<start)continue;
      if(otherStart>end)break;
      overlap+=Math.max(0,Math.min(end,otherEnd)-Math.max(start,otherStart)+1);
    }
    return overlap;
  };
  const conservativeGroups=[];
  for(const sourceItems of grouped.values()){
    const sourceNuclei=sourceItems.map(item=>item.nucleus),merge=nucleiMayShareCell(sourceNuclei,pixelSizeUm);
    for(const items of merge?[sourceItems]:sourceItems.map(item=>[item]))conservativeGroups.push({
      items,sourceNuclei,split:!merge,
    });
  }
  const detections=[];
  for(const {items,sourceNuclei,split} of conservativeGroups){
    const runs=mergeRuns(items),byRow=new Map();
    let area=0,sumX=0,sumY=0,edge=false;
    for(let run=0;run<runs.length;run+=3){
      const y=runs[run],start=runs[run+1],end=runs[run+2],length=end-start+1;
      area+=length;sumX+=(start+end)*length/2;sumY+=y*length;
      edge=edge||y===0||y===height-1||start===0||end===width-1;
      if(!byRow.has(y))byRow.set(y,[]);
      byRow.get(y).push([start,end]);
    }
    let perimeter=0;
    for(const [y,intervals] of byRow)for(const [start,end] of intervals){
      const length=end-start+1;
      perimeter+=2+length-overlapLength(start,end,byRow.get(y-1));
      perimeter+=length-overlapLength(start,end,byRow.get(y+1));
    }
    const nuclei=items.map(item=>item.nucleus);
    const nucleusIds=nuclei.map((nucleus,index)=>nucleus.id??`nucleus-${index+1}`);
    const nucleusLabels=nuclei.map((nucleus,index)=>nucleus.display_label??index+1);
    const reviewReasons=[];
    if(split)reviewReasons.push("crowded");
    if(nuclei.length>1)reviewReasons.push("multinucleated");
    if(nuclei.length>=3)reviewReasons.push("three_plus_nuclei");
    if(edge)reviewReasons.push("edge");
    if(area>Math.max(1,Number(params.max_area_px)||Infinity))reviewReasons.push("oversized");
    const fractions=items.map(item=>item.signal.fraction);
    const id=`${target}-cell-${detections.length+1}`;
    detections.push({
      id,cell_id:id,cell_instance_id:id,display_label:detections.length+1,
      x:area?sumX/area:nuclei.reduce((sum,nucleus)=>sum+nucleus.x,0)/nuclei.length,
      y:area?sumY/area:nuclei.reduce((sum,nucleus)=>sum+nucleus.y,0)/nuclei.length,
      radius:Math.sqrt(area/Math.PI),area_px:area,
      circularity:perimeter?Math.min(1,4*Math.PI*area/(perimeter*perimeter)):0,
      runs,signal_runs:runs.slice(),manual:false,deleted:false,
      object_type:"marker_cell_instance",nucleus_ids:nucleusIds,nucleus_labels:nucleusLabels,
      nucleus_count:nuclei.length,nuclei_per_cell:nuclei.length,edge_touching:edge,
      source_group_nucleus_count:sourceNuclei.length,
      source_group_nucleus_ids:sourceNuclei.map((nucleus,index)=>nucleus.id??`nucleus-${index+1}`),
      anchor_area_px:nuclei.reduce((sum,nucleus)=>sum+(Number(nucleus.area_px)||0),0),
      anchor_manual:nuclei.some(nucleus=>nucleus.manual),
      positive_fraction:fractions.reduce((sum,value)=>sum+value,0)/fractions.length,
      positive_fraction_min:Math.min(...fractions),positive_fraction_max:Math.max(...fractions),
      signal_background:median(items.map(item=>item.signal.background)),
      signal_mad:median(items.map(item=>item.signal.mad)),
      signal_threshold_actual:median(items.map(item=>item.signal.threshold)),
      resolved_signal_threshold:median(items.map(item=>item.signal.delta)),
      auto_signal_threshold:median(items.map(item=>item.signal.autoThreshold)),
      signal_threshold_user_min:median(items.map(item=>item.signal.userMinimum)),
      signal_threshold_mad:median(items.map(item=>item.signal.madThreshold)),
      ring_radius_px_resolved:median(items.map(item=>item.signal.ringRadiusPx)),
      review_required:reviewReasons.length>0,review_reasons:reviewReasons,
      nucleus_evidence:items.map(item=>({
        nucleus_id:item.nucleus.id,nucleus_label:item.nucleus.display_label,
        positive_fraction:item.signal.fraction,signal_area_px:item.signal.areaPx,
        signal_background:item.signal.background,signal_mad:item.signal.mad,
        signal_threshold_actual:item.signal.threshold,
        resolved_signal_threshold:item.signal.delta,
        auto_signal_threshold:item.signal.autoThreshold,
        signal_threshold_user_min:item.signal.userMinimum,
        signal_threshold_mad:item.signal.madThreshold,
      })),
    });
  }
  detections.sort((left,right)=>left.y-right.y||left.x-right.x);
  detections.forEach((detection,index)=>{
    detection.id=`${target}-cell-${index+1}`;
    detection.cell_id=detection.id;
    detection.cell_instance_id=detection.id;
    detection.display_label=index+1;
  });
  return detections;
}

function segmentParticles(data, width, height, params) {
  const smoothed = boxBlur(data, width, height, params.gaussian_sigma);
  let mask = thresholdMask(smoothed, params);
  mask = clearRegion(mask,scaleBarRegion(data,width,height),width);
  mask = opening(mask, width, height, params.opening_radius);
  const distance = distanceTransform(mask, width, height);
  const seeds = selectSeeds(mask, distance, width, height, params.watershed_min_distance);
  if (!seeds.length) return [];
  const labels = floodLabels(mask, width, height, seeds);
  const detections = regionDetections(labels, width, height, params);
  attachMaskRuns(labels, width, height, detections);
  return detections;
}

async function analyze(payload) {
  postProgress(`读取 ${payload.targetLabel} 通道`, 0.04);
  const channel = await decode(payload.channelBuffer, payload.channelExtension, payload.target);
  const {width, height} = channel;
  let detections,resolvedSignalThreshold=null;
  if (payload.target !== "dapi" && payload.params.analysis_mode === "nucleus_guided") {
    let nuclei;
    if (Array.isArray(payload.anchorDetections)) {
      postProgress("复用第一通道计数与人工修正", 0.34);
      nuclei = payload.anchorDetections;
    } else {
      postProgress("读取第一通道细胞核", 0.14);
      const anchor = await decode(payload.anchorBuffer, payload.anchorExtension, "dapi");
      if (anchor.width !== width || anchor.height !== height) throw new Error("第一通道与当前通道尺寸不一致");
      postProgress("分割第一通道细胞核", 0.34);
      nuclei = segmentParticles(anchor.data, width, height, payload.anchorParams);
    }
    nuclei=nuclei.map((nucleus,index)=>({...nucleus,display_label:nucleus.display_label??index+1}));
    const owners=nucleusOwners(nuclei,width,height);
    const pixelSizeUm=Math.max(.001,Number(payload.pixelSizeUm)||1);
    const scaleBar=scaleBarRegion(channel.data,width,height);
    if(payload.params.signal_threshold_mode==="auto"){
      postProgress("学习当前视野的背景校正信号阈值", 0.54);
      const histogram=new Uint32Array(256);
      for(let index=0;index<nuclei.length;index++){
        const sample=robustPositivity(channel.data,width,height,nuclei[index],index,nuclei,owners,
          payload.params,pixelSizeUm,scaleBar,{histogramOnly:true});
        for(let value=1;value<histogram.length;value++)histogram[value]+=sample.residualHistogram[value];
      }
      const otsu=otsuHistogramThreshold(histogram);
      const otsuForeground=otsu>=255?255:otsu+1;
      resolvedSignalThreshold=Math.max(Number(payload.params.signal_threshold)||0,otsuForeground);
    }
    postProgress("计算核周局部中位数与 MAD 信号", 0.68);
    const positiveNuclei=[];
    for (let index=0;index<nuclei.length;index++) {
      const nucleus=nuclei[index];
      const signal=robustPositivity(channel.data,width,height,nucleus,index,nuclei,owners,payload.params,pixelSizeUm,scaleBar,
        resolvedSignalThreshold===null?{}:{autoThreshold:resolvedSignalThreshold});
      if (!signal.areaPx||signal.fraction < payload.params.positive_fraction) continue;
      positiveNuclei.push({nucleus,signal});
    }
    detections=markerCellInstances(positiveNuclei,width,height,payload.target,payload.params,pixelSizeUm);
  } else {
    postProgress("平滑、阈值与自适应分水岭", 0.24);
    detections = segmentParticles(channel.data, width, height, payload.params);
  }
  postProgress("筛选颗粒", 0.82);
  for (const detection of detections) {
    detection.classification = payload.target;
    detection.area_um2 = detection.area_px * payload.pixelSizeUm ** 2;
  }
  postProgress("完成颗粒计数", 0.98);
  const result_kind=payload.target!=="dapi"&&payload.params.analysis_mode==="nucleus_guided"
    ? "cell_instances_v1":payload.target==="dapi"?"nuclei_v1":"particles_v1";
  return {detections, width, height, result_kind, resolved_signal_threshold:resolvedSignalThreshold};
}

onmessage = async event => {
  try {
    if(event.data.type!=="analyze")return;
    const result=await analyze(event.data);
    postMessage({type: "result", ...result});
  } catch (error) {
    postMessage({type: "error", error: error.message || String(error)});
  }
};
