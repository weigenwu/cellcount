/* global UTIF */
importScripts("https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.min.js");

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
  let total = 0, sum = 0;
  for (const value of data) {
    if (value > 0) { histogram[value]++; total++; sum += value; }
  }
  if (!total) return 255;
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, best = 0;
  for (let value = 0; value < 256; value++) {
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
    const threshold = otsuThreshold(data);
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= threshold ? 1 : 0;
  } else {
    const low = Math.max(0, Number(params.threshold_low));
    const high = Math.min(255, Number(params.threshold_high));
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= low && data[i] <= high ? 1 : 0;
  }
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

function regionDetections(labels, width, height, params) {
  let maxLabel = 0;
  for (const label of labels) if (label > maxLabel) maxLabel = label;
  const area = new Uint32Array(maxLabel + 1);
  const sumX = new Float64Array(maxLabel + 1);
  const sumY = new Float64Array(maxLabel + 1);
  const perimeter = new Uint32Array(maxLabel + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, label = labels[i];
      if (!label) continue;
      area[label]++; sumX[label] += x; sumY[label] += y;
      if (!x || labels[i - 1] !== label) perimeter[label]++;
      if (x === width - 1 || labels[i + 1] !== label) perimeter[label]++;
      if (!y || labels[i - width] !== label) perimeter[label]++;
      if (y === height - 1 || labels[i + width] !== label) perimeter[label]++;
    }
  }
  const detections = [];
  for (let label = 1; label <= maxLabel; label++) {
    if (!area[label]) continue;
    const circularity = Math.min(1, 4 * Math.PI * area[label] / Math.max(1, perimeter[label] ** 2));
    if (area[label] < params.min_area_px || area[label] > params.max_area_px ||
        circularity < params.min_circularity || circularity > params.max_circularity) continue;
    detections.push({
      id: `auto-${detections.length + 1}`,
      _label: label,
      x: sumX[label] / area[label],
      y: sumY[label] / area[label],
      area_px: area[label],
      radius: Math.sqrt(area[label] / Math.PI),
      circularity,
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

function positivity(signal, width, height, detection, radiusPx, threshold) {
  const innerRadius = detection.radius + radiusPx;
  const bgStart = innerRadius + Math.max(2, radiusPx);
  const bgEnd = bgStart + Math.max(4, radiusPx);
  const x0 = Math.max(0, Math.floor(detection.x - bgEnd));
  const x1 = Math.min(width - 1, Math.ceil(detection.x + bgEnd));
  const y0 = Math.max(0, Math.floor(detection.y - bgEnd));
  const y1 = Math.min(height - 1, Math.ceil(detection.y + bgEnd));
  const inner = [], background = [];
  const inner2 = innerRadius ** 2, bgStart2 = bgStart ** 2, bgEnd2 = bgEnd ** 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - detection.x) ** 2 + (y - detection.y) ** 2;
      const value = signal[y * width + x];
      if (d2 <= inner2) inner.push(value);
      else if (d2 >= bgStart2 && d2 <= bgEnd2) background.push(value);
    }
  }
  background.sort((a, b) => a - b);
  const baseline = background.length ? background[Math.floor(background.length / 2)] : 0;
  let positive = 0;
  for (const value of inner) if (value - baseline >= threshold) positive++;
  return {fraction: inner.length ? positive / inner.length : 0, background: baseline};
}

function segmentParticles(data, width, height, params) {
  const smoothed = boxBlur(data, width, height, params.gaussian_sigma);
  let mask = thresholdMask(smoothed, params);
  mask = opening(mask, width, height, params.opening_radius);
  const distance = distanceTransform(mask, width, height);
  const seeds = selectSeeds(mask, distance, width, height, params.watershed_min_distance);
  if (!seeds.length) return [];
  const labels = floodLabels(mask, width, height, seeds);
  const detections = regionDetections(labels, width, height, params);
  attachMaskRuns(labels, width, height, detections);
  return detections;
}

function histogramQuantile(data,quantile,ignoreZero=true) {
  const histogram=new Uint32Array(256);
  let total=0;
  for(const value of data){
    if(ignoreZero&&value===0)continue;
    histogram[value]++;total++;
  }
  if(!total)return 255;
  const target=Math.max(0,Math.min(total-1,Math.floor(total*quantile)));
  let count=0;
  for(let value=0;value<256;value++){
    count+=histogram[value];
    if(count>target)return value;
  }
  return 255;
}

function enclosureMetrics(red,width,height,detection,params,redThreshold) {
  const innerRadius=Math.max(7,Number(detection.radius)||12);
  const ringWidth=Math.max(8,Number(params.ring_width_px)||36);
  const outerRadius=innerRadius+ringWidth;
  const x0=Math.max(0,Math.floor(detection.x-outerRadius));
  const x1=Math.min(width-1,Math.ceil(detection.x+outerRadius));
  const y0=Math.max(0,Math.floor(detection.y-outerRadius));
  const y1=Math.min(height-1,Math.ceil(detection.y+outerRadius));
  const sectorCount=16;
  const sectorPixels=new Uint32Array(sectorCount);
  const sectorPositive=new Uint32Array(sectorCount);
  const nearPixels=new Uint32Array(sectorCount);
  const nearPositive=new Uint32Array(sectorCount);
  const farPixels=new Uint32Array(sectorCount);
  const farPositive=new Uint32Array(sectorCount);
  let ringSum=0,ringPixels=0,innerSum=0,innerPixels=0;
  const inner2=(innerRadius*.8)**2;
  const ringStart2=(innerRadius*1.05)**2;
  const middle2=(innerRadius+ringWidth*.52)**2;
  const outer2=outerRadius**2;
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const dx=x-detection.x,dy=y-detection.y,d2=dx*dx+dy*dy;
      const value=red[y*width+x];
      if(d2<=inner2){innerSum+=value;innerPixels++;continue;}
      if(d2<ringStart2||d2>outer2)continue;
      let angle=Math.atan2(dy,dx);
      if(angle<0)angle+=Math.PI*2;
      const sector=Math.min(sectorCount-1,Math.floor(angle/(Math.PI*2)*sectorCount));
      sectorPixels[sector]++;ringPixels++;ringSum+=value;
      if(d2<=middle2){
        nearPixels[sector]++;
        if(value>=redThreshold)nearPositive[sector]++;
      }else{
        farPixels[sector]++;
        if(value>=redThreshold)farPositive[sector]++;
      }
      if(value>=redThreshold)sectorPositive[sector]++;
    }
  }
  let enclosedSectors=0;
  const requiredFraction=Math.max(.02,Number(params.sector_positive_fraction)||.18);
  const flags=[],nearFlags=[],farFlags=[];
  for(let sector=0;sector<sectorCount;sector++){
    const positive=Boolean(sectorPixels[sector]&&sectorPositive[sector]/sectorPixels[sector]>=requiredFraction);
    const near=Boolean(nearPixels[sector]&&nearPositive[sector]/nearPixels[sector]>=requiredFraction);
    const far=Boolean(farPixels[sector]&&farPositive[sector]/farPixels[sector]>=requiredFraction);
    flags.push(positive);nearFlags.push(near);farFlags.push(far);
    if(positive)enclosedSectors++;
  }
  let oppositePairs=0,radialSectors=0;
  for(let sector=0;sector<sectorCount/2;sector++){
    if(flags[sector]&&flags[sector+sectorCount/2])oppositePairs++;
  }
  for(let sector=0;sector<sectorCount;sector++){
    if(nearFlags[sector]&&farFlags[sector])radialSectors++;
  }
  let quadrantCount=0;
  for(let quadrant=0;quadrant<4;quadrant++){
    if(flags.slice(quadrant*4,quadrant*4+4).some(Boolean))quadrantCount++;
  }
  let largestGap=0,currentGap=0;
  for(let index=0;index<sectorCount*2;index++){
    if(flags[index%sectorCount])currentGap=0;
    else{currentGap++;largestGap=Math.max(largestGap,Math.min(currentGap,sectorCount));}
  }
  const ringMean=ringPixels?ringSum/ringPixels:0;
  const innerMean=innerPixels?innerSum/innerPixels:0;
  return {
    coverage:enclosedSectors/sectorCount,
    contrast:(ringMean-innerMean)/(ringMean+10),
    oppositePairs,quadrantCount,largestGap,
    radialCoherence:radialSectors/sectorCount,
    nearCoverage:nearFlags.filter(Boolean).length/sectorCount,
    farCoverage:farFlags.filter(Boolean).length/sectorCount,
    ringMean,innerMean,innerRadius,outerRadius,
  };
}
function nearestHostDetection(origin,detections,metrics,params,excludeId=null) {
  let best=null,bestDistance=Infinity;
  for(const item of detections){
    if(item.id===excludeId)continue;
    const distance=Math.hypot(item.x-origin.x,item.y-origin.y);
    const combinedRadius=Math.max(4,(Number(origin.radius)||12)+(Number(item.radius)||12));
    const minimum=combinedRadius*Math.max(.35,Number(params.min_host_separation_factor)||.58);
    const adaptiveMaximum=Math.min(
      Math.max(20,Number(params.host_max_distance_px)||150),
      metrics.outerRadius+(Number(item.radius)||12)*Math.max(1,Number(params.host_radius_allowance)||1.8)
    );
    if(distance<minimum||distance>adaptiveMaximum)continue;
    if(distance<bestDistance){best=item;bestDistance=distance;}
  }
  return best?{item:best,distance:bestDistance}:null;
}
function heterotypicEvidence(metrics,params) {
  const requested=Math.max(.25,Number(params.min_enclosure_coverage)||.55);
  const strict=metrics.coverage>=Math.max(.8,requested)
    &&metrics.contrast>=params.min_ring_contrast
    &&metrics.oppositePairs>=3&&metrics.quadrantCount===4
    &&metrics.largestGap<=3&&metrics.radialCoherence>=.44;
  const annotated=params.evidence_profile!=="strict_complete"
    &&metrics.coverage>=requested
    &&metrics.contrast>=params.min_ring_contrast
    &&metrics.oppositePairs>=2&&metrics.quadrantCount>=3
    &&metrics.largestGap<=6&&metrics.radialCoherence>=.25;
  if(strict)return{pass:true,grade:"A",rule:"complete_multidirectional_enclosure"};
  if(annotated)return{pass:true,grade:"B",rule:"ppt_annotated_partial_enclosure"};
  return{pass:false,grade:"",rule:"insufficient_multidirectional_enclosure"};
}
function cicConfidence(metrics,hostDistance,params,type,grade="A",areaRatio=1) {
  const minCoverage=type==="homotypic"?params.homotypic_min_coverage:params.min_enclosure_coverage;
  const coverageScore=Math.max(0,Math.min(1,(metrics.coverage-minCoverage)/(1-minCoverage+.001)));
  const contrastScore=Math.max(0,Math.min(1,(metrics.contrast-params.min_ring_contrast)/.45));
  const proximityScore=Math.max(0,1-hostDistance/Math.max(1,params.host_max_distance_px));
  const morphologyScore=Math.min(1,
    metrics.oppositePairs/5*.3+metrics.quadrantCount/4*.2+
    (1-metrics.largestGap/16)*.2+metrics.radialCoherence*.3
  );
  const sizeScore=Math.max(0,Math.min(1,1/Math.max(1,areaRatio)));
  const gradeBase=grade==="A"?.48:.39;
  return Math.min(.99,gradeBase+.17*coverageScore+.13*contrastScore+.1*proximityScore+.09*morphologyScore+.04*sizeScore);
}
function median(values) {
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
function analyzeCicCandidates(red,width,height,nkDetections,tumorDetections,params) {
  const redThreshold=Math.max(12,histogramQuantile(red,Number(params.red_quantile)||.72));
  const events=[];
  const typicalNkRadius=median(nkDetections.map(item=>Number(item.radius)||0).filter(value=>value>0));
  for(const inner of nkDetections){
    const innerSizeRatio=typicalNkRadius?(Number(inner.radius)||12)/typicalNkRadius:1;
    if(!inner.manual&&innerSizeRatio>Math.max(1.2,Number(params.max_inner_radius_factor)||1.8))continue;
    const metrics=enclosureMetrics(red,width,height,inner,params,redThreshold);
    const evidence=heterotypicEvidence(metrics,params);
    if(!evidence.pass)continue;
    const host=nearestHostDetection(inner,tumorDetections,metrics,params);
    if(!host)continue;
    const areaRatio=(Number(inner.area_px)||Math.PI*(inner.radius||12)**2)
      /Math.max(1,Number(host.item.area_px)||Math.PI*(host.item.radius||12)**2);
    if(areaRatio>Math.max(1,Number(params.max_inner_host_area_ratio)||1.5))continue;
    events.push({
      id:`cic-auto-hetero-${events.length+1}`,
      x:inner.x,y:inner.y,inner_radius:metrics.innerRadius,outer_radius:metrics.outerRadius,
      outer_x:host.item.x,outer_y:host.item.y,
      inner_cell_id:inner.id,outer_cell_id:host.item.id,
      inner_cell_type:"nk",outer_cell_type:"tumor",
      type_hint:"heterotypic",classification:"pending",
      enclosure_coverage:metrics.coverage,ring_contrast:metrics.contrast,
      evidence_grade:evidence.grade,evidence_rule:evidence.rule,
      opposite_pairs:metrics.oppositePairs,quadrant_count:metrics.quadrantCount,
      largest_gap_sectors:metrics.largestGap,radial_coherence:metrics.radialCoherence,
      near_coverage:metrics.nearCoverage,far_coverage:metrics.farCoverage,
      host_distance_px:host.distance,inner_host_area_ratio:areaRatio,
      inner_radius_typical_ratio:innerSizeRatio,
      inner_positive_fraction:Number(inner.positive_fraction)||null,
      confidence:cicConfidence(metrics,host.distance,params,"heterotypic",evidence.grade,areaRatio),
      red_threshold:redThreshold,source:"automatic_2d_candidate",manual:false,reviewed:false,deleted:false,
    });
  }
  if(params.homotypic_enabled){
    const pairs=new Map();
    for(const inner of tumorDetections){
      const metrics=enclosureMetrics(red,width,height,inner,params,redThreshold);
      if(metrics.coverage<params.homotypic_min_coverage||metrics.contrast<params.min_ring_contrast)continue;
      const host=nearestHostDetection(inner,tumorDetections,metrics,params,inner.id);
      if(!host||host.item.circularity>params.homotypic_host_max_circularity)continue;
      const key=[inner.id,host.item.id].sort().join("|");
      const candidate={
        id:"",x:inner.x,y:inner.y,inner_radius:metrics.innerRadius,outer_radius:metrics.outerRadius,
        outer_x:host.item.x,outer_y:host.item.y,
        inner_cell_id:inner.id,outer_cell_id:host.item.id,
        inner_cell_type:"tumor",outer_cell_type:"tumor",
        type_hint:"homotypic",classification:"pending",
        enclosure_coverage:metrics.coverage,ring_contrast:metrics.contrast,
        evidence_grade:"A",evidence_rule:"conservative_homotypic_enclosure",
        opposite_pairs:metrics.oppositePairs,quadrant_count:metrics.quadrantCount,
        largest_gap_sectors:metrics.largestGap,radial_coherence:metrics.radialCoherence,
        near_coverage:metrics.nearCoverage,far_coverage:metrics.farCoverage,
        host_distance_px:host.distance,
        confidence:cicConfidence(metrics,host.distance,params,"homotypic","A",1),
        red_threshold:redThreshold,source:"automatic_2d_candidate",manual:false,reviewed:false,deleted:false,
      };
      if(!pairs.has(key)||candidate.confidence>pairs.get(key).confidence)pairs.set(key,candidate);
    }
    for(const candidate of pairs.values()){
      candidate.id=`cic-auto-homo-${events.length+1}`;
      events.push(candidate);
    }
  }
  const gradeRank=event=>event.evidence_grade==="A"?2:event.evidence_grade==="B"?1:0;
  events.sort((a,b)=>gradeRank(b)-gradeRank(a)||b.confidence-a.confidence);
  const limit=Math.max(10,Math.round(params.max_candidates||200));
  return events.slice(0,limit).map((event,index)=>({...event,id:`cic-auto-${index+1}`}));
}

async function analyzeCic(payload) {
  postProgress("读取肿瘤通道并计算红色包围结构",.12);
  const red=await decode(payload.redBuffer,payload.redExtension,"tumor");
  postProgress("筛查 NK–肿瘤异质 CIC 候选",.42);
  const events=analyzeCicCandidates(
    red.data,red.width,red.height,
    Array.isArray(payload.nkDetections)?payload.nkDetections:[],
    Array.isArray(payload.tumorDetections)?payload.tumorDetections:[],
    {...payload.params}
  );
  postProgress("生成待人工复核 CIC 列表",.96);
  return {events,width:red.width,height:red.height};
}

async function analyze(payload) {
  postProgress(`读取 ${payload.targetLabel} 通道`, 0.04);
  const channel = await decode(payload.channelBuffer, payload.channelExtension, payload.target);
  const {width, height} = channel;
  let detections;
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
    postProgress("计算核周背景校正信号", 0.68);
    detections = [];
    for (const nucleus of nuclei) {
      const signal = positivity(
        channel.data, width, height, nucleus,
        payload.params.ring_radius_px, payload.params.signal_threshold
      );
      if (signal.fraction < payload.params.positive_fraction) continue;
      detections.push({
        ...nucleus,
        id:`auto-${detections.length + 1}`,
        manual:false,
        deleted:false,
        anchor_manual:Boolean(nucleus.manual),
        positive_fraction:signal.fraction,
        signal_background:signal.background,
      });
    }
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
  return {detections, width, height};
}

onmessage = async event => {
  try {
    let result;
    if(event.data.type==="analyze")result=await analyze(event.data);
    else if(event.data.type==="analyze_cic")result=await analyzeCic(event.data);
    else return;
    postMessage({type: "result", ...result});
  } catch (error) {
    postMessage({type: "error", error: error.message || String(error)});
  }
};
