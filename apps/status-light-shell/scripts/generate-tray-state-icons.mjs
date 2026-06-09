import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ROOT_DIR = process.cwd();
const OUTPUT_DIR = path.resolve(ROOT_DIR, "apps/status-light-shell/src-tauri/icons/state");
const MACOS_OUTPUT_DIR = path.resolve(
  ROOT_DIR,
  "apps/status-light-shell/src-tauri/icons/state-macos"
);

const STATES = ["green", "yellow", "red", "neutral"];

const FRAME_FILL = [18, 28, 35];
const FRAME_GLOSS = [255, 255, 255];
const SHADOW = [9, 14, 18];

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function roundedRectAlpha(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  const dx =
    x < left + radius ? left + radius - x : x > right - radius ? x - (right - radius) : 0;
  const dy =
    y < top + radius ? top + radius - y : y > bottom - radius ? y - (bottom - radius) : 0;

  if (dx === 0 && dy === 0) {
    return 1;
  }

  return dx * dx + dy * dy <= radius * radius ? 1 : 0;
}

function circleSoftAlpha(x, y, cx, cy, radius, feather = 1.75) {
  const distance = Math.hypot(x - cx, y - cy);

  if (distance <= radius - feather) {
    return 1;
  }

  if (distance >= radius + feather) {
    return 0;
  }

  return clamp((radius + feather - distance) / (feather * 2));
}

function glowAlpha(x, y, cx, cy, radius, spread, intensity) {
  const distance = Math.hypot(x - cx, y - cy);
  const normalized = distance / (radius + spread);
  return intensity * Math.exp(-(normalized * normalized) * 2.4);
}

function mixChannel(base, overlay, alpha) {
  return base * (1 - alpha) + overlay * alpha;
}

function blendColor(base, overlay, amount) {
  return base.map((channel, index) => Math.round(mixChannel(channel, overlay[index], amount)));
}

function lerpColor(from, to, amount) {
  return from.map((channel, index) => Math.round(mixChannel(channel, to[index], amount)));
}

function compositePixel(pixel, color, alpha) {
  if (alpha <= 0) {
    return pixel;
  }

  const baseAlpha = pixel[3] / 255;
  const nextAlpha = alpha + baseAlpha * (1 - alpha);

  if (nextAlpha <= 0) {
    return pixel;
  }

  pixel[0] = Math.round(
    (color[0] * alpha + pixel[0] * baseAlpha * (1 - alpha)) / nextAlpha
  );
  pixel[1] = Math.round(
    (color[1] * alpha + pixel[1] * baseAlpha * (1 - alpha)) / nextAlpha
  );
  pixel[2] = Math.round(
    (color[2] * alpha + pixel[2] * baseAlpha * (1 - alpha)) / nextAlpha
  );
  pixel[3] = Math.round(nextAlpha * 255);
  return pixel;
}

function highlightColor(base, amount) {
  return base.map((channel) => Math.round(mixChannel(channel, 255, amount)));
}

function pastelColor(base, amount) {
  return blendColor(base, [255, 255, 255], amount);
}

function shadeColor(base, amount) {
  return blendColor(base, [32, 40, 48], amount);
}

function dimColor(base, amount) {
  return base.map((channel, index) =>
    Math.round(mixChannel(channel, [126, 137, 144][index], amount))
  );
}

function ringAlpha(x, y, cx, cy, outerRadius, innerRadius, outerFeather = 1, innerFeather = 1) {
  return clamp(
    circleSoftAlpha(x, y, cx, cy, outerRadius, outerFeather) -
      circleSoftAlpha(x, y, cx, cy, innerRadius, innerFeather),
    0,
    1
  );
}

function squareVariant() {
  return {
    width: 64,
    height: 64,
    outputDir: OUTPUT_DIR,
    lamps: [
      { key: "green", x: 14, y: 32, color: [61, 191, 110] },
      { key: "yellow", x: 32, y: 32, color: [239, 187, 23] },
      { key: "red", x: 50, y: 32, color: [225, 94, 77] }
    ],
    drawBase(px, x, y) {
      const shadowMask = roundedRectAlpha(x, y, 3, 16, 58, 32, 16);
      if (shadowMask > 0) {
        compositePixel(px, SHADOW, 0.1 * shadowMask);
      }

      const frameMask = roundedRectAlpha(x, y, 4, 18, 56, 28, 14);
      if (frameMask > 0) {
        compositePixel(px, FRAME_FILL, 0.18 * frameMask);
      }

      const glossMask = roundedRectAlpha(x, y, 6, 19, 52, 9, 10);
      if (glossMask > 0) {
        compositePixel(px, FRAME_GLOSS, 0.05 * glossMask);
      }
    },
    lampStyle(isActive, isNeutral) {
      return {
        glowRadius: 11.6,
        glowSpread: 11.4,
        glowIntensity: isActive ? 0.44 : isNeutral ? 0.07 : 0.11,
        bodyRadius: isActive ? 11.1 : 10.5,
        bodyFeather: 1.5,
        rimOuter: 12.4,
        rimInner: 10.8,
        ringRadius: 12,
        ringFeather: 1,
        shineX: -3.5,
        shineY: -3.8,
        shineRadius: 3.8,
        shineFeather: 1.05,
        dimAmount: isNeutral ? 0.58 : 0.42,
        bodyAlpha: isActive ? 1 : 0.68,
        highlightAmount: isActive ? 0.2 : 0.06,
        ringAlpha: isActive ? 0.28 : 0.14,
        shineAlpha: isActive ? 0.34 : 0.12,
        rimAlpha: 0.18,
        coreRadius: isActive ? 4.6 : 4.1,
        coreAlpha: isActive ? 0.22 : 0.08,
        seatGlowRadius: 11.4,
        seatGlowSpread: 6.2,
        seatGlowAlpha: isActive ? 0.14 : 0.03,
        seatOuter: 12.7,
        seatInner: 10.8,
        seatAlpha: isActive ? 0.16 : 0.04,
        seatTint: isActive ? 0.42 : 0.26,
        rimTint: isActive ? 0.34 : 0.18,
        shadowTint: isActive ? 0.12 : 0.22,
        bodyBaseAlpha: isActive ? 0.36 : 0.16,
        highlightRadius: isActive ? 4.8 : 4.2,
        highlightX: -0.8,
        highlightY: -1.9,
        highlightAlpha: isActive ? 0.18 : 0.08,
        neutralTint: 0.26,
        inactiveTint: 0.2
      };
    }
  };
}

function macosVariant() {
  const scale = 3;
  const scaled = (value) => value * scale;
  const panelLeft = scaled(3);
  const panelTop = scaled(3);
  const panelWidth = scaled(68);
  const panelHeight = scaled(16);
  const panelRadius = scaled(8);
  const panelInnerLeft = scaled(3.85);
  const panelInnerTop = scaled(3.75);
  const panelInnerWidth = scaled(66.3);
  const panelInnerHeight = scaled(14.35);
  const panelInnerRadius = scaled(7.15);

  return {
    width: Math.ceil(74 * scale),
    height: Math.ceil(22 * scale),
    outputDir: MACOS_OUTPUT_DIR,
    lamps: [
      { key: "red", x: scaled(19), y: scaled(11), color: [235, 44, 44], glowColor: [255, 65, 54] },
      { key: "yellow", x: scaled(37), y: scaled(11), color: [255, 177, 0], glowColor: [255, 202, 40] },
      { key: "green", x: scaled(55), y: scaled(11), color: [50, 184, 69], glowColor: [72, 208, 95] }
    ],
    drawBase(px, x, y) {
      const shellShadow = roundedRectAlpha(
        x,
        y,
        panelLeft + scaled(0.7),
        panelTop + scaled(1.1),
        panelWidth - scaled(0.3),
        panelHeight - scaled(0.3),
        panelRadius - scaled(0.1)
      );
      if (shellShadow > 0) {
        compositePixel(px, [4, 8, 13], 0.18 * shellShadow);
      }

      const panelMask = roundedRectAlpha(
        x,
        y,
        panelLeft,
        panelTop,
        panelWidth,
        panelHeight,
        panelRadius
      );
      if (panelMask > 0) {
        const panelT = clamp((y - panelTop) / panelHeight);
        const panelColor =
          panelT < 0.48
            ? lerpColor([31, 40, 51], [17, 24, 33], panelT / 0.48)
            : lerpColor([17, 24, 33], [12, 17, 24], (panelT - 0.48) / 0.52);
        compositePixel(px, panelColor, 0.985 * panelMask);
      }

      const innerMask = roundedRectAlpha(
        x,
        y,
        panelInnerLeft,
        panelInnerTop,
        panelInnerWidth,
        panelInnerHeight,
        panelInnerRadius
      );
      if (innerMask > 0) {
        const innerT = clamp((y - panelInnerTop) / panelInnerHeight);
        const innerColor =
          innerT < 0.54
            ? lerpColor([43, 53, 65], [24, 32, 42], innerT / 0.54)
            : lerpColor([24, 32, 42], [15, 21, 28], (innerT - 0.54) / 0.46);
        compositePixel(px, innerColor, 0.29 * innerMask);
      }

      const shellEdge =
        roundedRectAlpha(x, y, panelLeft, panelTop, panelWidth, panelHeight, panelRadius) -
        roundedRectAlpha(
          x,
          y,
          panelInnerLeft,
          panelInnerTop,
          panelInnerWidth,
          panelInnerHeight,
          panelInnerRadius
      );
      if (shellEdge > 0) {
        compositePixel(px, [6, 9, 14], 0.18 * clamp(shellEdge, 0, 1));
      }

      const topGloss = roundedRectAlpha(
        x,
        y,
        scaled(8.8),
        scaled(4.1),
        scaled(30.5),
        scaled(2.2),
        scaled(1.3)
      );
      if (topGloss > 0) {
        compositePixel(px, FRAME_GLOSS, 0.13 * topGloss);
      }

      const topSheen = glowAlpha(
        x,
        y,
        scaled(15.2),
        scaled(4.9),
        scaled(9.5),
        scaled(14.5),
        0.1
      );
      if (topSheen > 0) {
        compositePixel(px, FRAME_GLOSS, topSheen);
      }

      const lowerShadow = roundedRectAlpha(
        x,
        y,
        scaled(12.4),
        scaled(16.9),
        scaled(33.5),
        scaled(1),
        scaled(0.5)
      );
      if (lowerShadow > 0) {
        compositePixel(px, [0, 0, 0], 0.09 * lowerShadow);
      }
    },
    drawLamp(px, x, y, lamp, activeState) {
      const isActive = lamp.key === activeState;
      const isNeutral = activeState === "neutral";
      const glowStrength = isActive ? 0.68 : isNeutral ? 0.07 : 0.03;
      const seatGlow = glowAlpha(
        x,
        y,
        lamp.x,
        lamp.y,
        scaled(7.5),
        scaled(2.9),
        glowStrength * 0.82
      );
      if (seatGlow > 0) {
        compositePixel(px, pastelColor(lamp.glowColor, 0.58), seatGlow);
      }

      const bezelOuter = circleSoftAlpha(x, y, lamp.x, lamp.y, scaled(8.7), scaled(0.5));
      const bezelInner = circleSoftAlpha(x, y, lamp.x, lamp.y, scaled(7.25), scaled(0.38));
      const bezelRing = clamp(bezelOuter - bezelInner, 0, 1);
      const bezelHighlight = ringAlpha(
        x,
        y,
        lamp.x,
        lamp.y - scaled(0.25),
        scaled(8.35),
        scaled(7.45),
        scaled(0.34),
        scaled(0.28)
      );
      const bezelShadow = ringAlpha(
        x,
        y,
        lamp.x,
        lamp.y + scaled(0.48),
        scaled(8.45),
        scaled(7.3),
        scaled(0.3),
        scaled(0.24)
      );
      compositePixel(px, [30, 39, 48], bezelOuter * 0.96);
      compositePixel(px, [8, 11, 16], bezelInner * 0.92);
      compositePixel(px, [46, 57, 69], bezelRing * 0.4);
      compositePixel(px, FRAME_GLOSS, bezelHighlight * 0.18);
      compositePixel(px, [0, 0, 0], bezelShadow * 0.18);

      const body = circleSoftAlpha(x, y, lamp.x, lamp.y, scaled(5.95), scaled(0.3));
      const bodyShadow = circleSoftAlpha(
        x,
        y,
        lamp.x,
        lamp.y + scaled(0.72),
        scaled(5.55),
        scaled(0.34)
      );
      const ring = ringAlpha(
        x,
        y,
        lamp.x,
        lamp.y,
        scaled(6.05),
        scaled(5.35),
        scaled(0.2),
        scaled(0.18)
      );
      const highlight = circleSoftAlpha(
        x,
        y,
        lamp.x - scaled(1.5),
        lamp.y - scaled(1.7),
        scaled(1.68),
        scaled(0.24)
      );
      const topBloom = circleSoftAlpha(
        x,
        y,
        lamp.x,
        lamp.y - scaled(1.4),
        scaled(3.2),
        scaled(0.34)
      );
      const coreGlow = circleSoftAlpha(
        x,
        y,
        lamp.x - scaled(0.48),
        lamp.y - scaled(0.6),
        scaled(2.45),
        scaled(0.22)
      );
      const haloRing = ringAlpha(
        x,
        y,
        lamp.x,
        lamp.y,
        scaled(7.15),
        scaled(6.05),
        scaled(0.34),
        scaled(0.28)
      );
      const glassWash = circleSoftAlpha(
        x,
        y,
        lamp.x - scaled(0.12),
        lamp.y - scaled(1.15),
        scaled(4.55),
        scaled(0.4)
      );
      const innerLift = circleSoftAlpha(
        x,
        y,
        lamp.x + scaled(0.24),
        lamp.y - scaled(0.12),
        scaled(3),
        scaled(0.24)
      );
      const upperHalo = glowAlpha(
        x,
        y,
        lamp.x,
        lamp.y - scaled(0.7),
        scaled(5.8),
        scaled(2.8),
        isActive ? 0.24 : isNeutral ? 0.022 : 0.035
      );
      const lowerReflect = circleSoftAlpha(
        x,
        y,
        lamp.x,
        lamp.y + scaled(1.95),
        scaled(4.2),
        scaled(0.3)
      );

      const bodyColor = isNeutral
        ? blendColor(lamp.color, [76, 86, 96], 0.62)
        : isActive
          ? blendColor(lamp.color, [255, 255, 255], 0.12)
          : blendColor(lamp.color, [44, 52, 60], 0.74);
      const glowColor = isActive
        ? blendColor(lamp.glowColor, [255, 255, 255], 0.16)
        : blendColor(lamp.glowColor, [90, 98, 108], 0.7);

      const outerGlow = glowAlpha(
        x,
        y,
        lamp.x,
        lamp.y,
        scaled(6.85),
        scaled(3.75),
        glowStrength
      );
      if (outerGlow > 0) {
        compositePixel(px, glowColor, outerGlow);
      }
      if (upperHalo > 0) {
        compositePixel(px, pastelColor(lamp.glowColor, 0.84), upperHalo);
      }

      compositePixel(px, bodyColor, body * (isActive ? 0.998 : isNeutral ? 0.28 : 0.42));
      compositePixel(
        px,
        shadeColor(bodyColor, isActive ? 0.12 : 0.26),
        bodyShadow * body * (isActive ? 0.22 : 0.16)
      );
      compositePixel(
        px,
        highlightColor(bodyColor, isActive ? 0.38 : 0.08),
        topBloom * body * (isActive ? 0.44 : 0.08)
      );
      if (haloRing > 0) {
        compositePixel(
          px,
          pastelColor(lamp.glowColor, 0.82),
          haloRing * (isActive ? 0.28 : isNeutral ? 0.03 : 0.04)
        );
      }
      if (glassWash > 0) {
        compositePixel(
          px,
          highlightColor(bodyColor, isActive ? 0.5 : 0.1),
          glassWash * body * (isActive ? 0.34 : 0.06)
        );
      }
      if (innerLift > 0) {
        compositePixel(px, FRAME_GLOSS, innerLift * body * (isActive ? 0.26 : 0.05));
      }
      if (lowerReflect > 0) {
        compositePixel(
          px,
          shadeColor(bodyColor, isActive ? 0.08 : 0.18),
          lowerReflect * body * (isActive ? 0.11 : 0.03)
        );
      }
      compositePixel(px, FRAME_GLOSS, highlight * (isActive ? 0.58 : isNeutral ? 0.1 : 0.13));
      compositePixel(
        px,
        FRAME_GLOSS,
        coreGlow * body * (isActive ? 0.48 : isNeutral ? 0.06 : 0.08)
      );
      compositePixel(px, pastelColor(bodyColor, 0.54), ring * (isActive ? 0.3 : 0.04));
    }
  };
}

function createStateImage(activeState, variant) {
  const pixels = new Uint8Array(variant.width * variant.height * 4);

  for (let y = 0; y < variant.height; y += 1) {
    for (let x = 0; x < variant.width; x += 1) {
      const index = (y * variant.width + x) * 4;
      const px = [0, 0, 0, 0];

      variant.drawBase(px, x, y, variant);

      for (const lamp of variant.lamps) {
        if (variant.drawLamp) {
          variant.drawLamp(px, x, y, lamp, activeState, variant);
          continue;
        }

        const isActive = lamp.key === activeState;
        const isNeutral = activeState === "neutral";
        const style = variant.lampStyle(isActive, isNeutral);
        const glow = glowAlpha(
          x,
          y,
          lamp.x,
          lamp.y,
          style.glowRadius,
          style.glowSpread,
          style.glowIntensity
        );
        const body = circleSoftAlpha(
          x,
          y,
          lamp.x,
          lamp.y,
          style.bodyRadius,
          style.bodyFeather
        );
        const rimShadow =
          circleSoftAlpha(x, y, lamp.x, lamp.y, style.rimOuter, 1) -
          circleSoftAlpha(x, y, lamp.x, lamp.y, style.rimInner, 0.9);
        const ring =
          circleSoftAlpha(x, y, lamp.x, lamp.y, style.ringRadius, style.ringFeather) - body;
        const shine = circleSoftAlpha(
          x,
          y,
          lamp.x + style.shineX,
          lamp.y + style.shineY,
          style.shineRadius,
          style.shineFeather
        );
        const core =
          style.coreRadius && style.coreAlpha
            ? circleSoftAlpha(x, y, lamp.x, lamp.y, style.coreRadius, 0.8)
            : 0;
        const seatGlow =
          style.seatGlowRadius && style.seatGlowAlpha
            ? glowAlpha(
                x,
                y,
                lamp.x,
                lamp.y,
                style.seatGlowRadius,
                style.seatGlowSpread ?? 3,
                style.seatGlowAlpha
              )
            : 0;
        const seatRing =
          style.seatOuter && style.seatInner && style.seatAlpha
            ? ringAlpha(
                x,
                y,
                lamp.x,
                lamp.y,
                style.seatOuter,
                style.seatInner,
                style.seatOuterFeather ?? 0.8,
                style.seatInnerFeather ?? 0.8
              )
            : 0;
        const bodyShadow =
          style.bodyShadowRadius && style.bodyShadowAlpha
            ? circleSoftAlpha(
                x,
                y,
                lamp.x + (style.bodyShadowX ?? 0),
                lamp.y + (style.bodyShadowY ?? 1.2),
                style.bodyShadowRadius,
                style.bodyShadowFeather ?? 1
              ) * body
            : 0;
        const highlightDisk =
          style.highlightRadius && style.highlightAlpha
            ? circleSoftAlpha(
                x,
                y,
                lamp.x + (style.highlightX ?? 0),
                lamp.y + (style.highlightY ?? -1.8),
                style.highlightRadius,
                style.highlightFeather ?? 1
              ) * body
            : 0;
        const lampColor = isNeutral
          ? pastelColor(lamp.color, style.neutralTint ?? 0.18)
          : isActive
            ? lamp.color
            : style.inactiveTint !== undefined
              ? pastelColor(lamp.color, style.inactiveTint)
              : dimColor(lamp.color, style.dimAmount);
        const seatColor =
          style.seatTint !== undefined ? pastelColor(lamp.color, style.seatTint) : FRAME_GLOSS;
        const ringColor =
          style.rimTint !== undefined ? pastelColor(lamp.color, style.rimTint) : FRAME_GLOSS;
        const bodyShadowColor =
          style.shadowTint !== undefined ? shadeColor(lampColor, style.shadowTint) : SHADOW;

        compositePixel(px, SHADOW, clamp(rimShadow, 0, 1) * style.rimAlpha);
        if (seatGlow > 0) {
          compositePixel(px, seatColor, seatGlow);
        }
        compositePixel(px, lampColor, glow);
        if (seatRing > 0) {
          compositePixel(px, seatColor, seatRing * style.seatAlpha);
        }
        if (style.bodyBaseAlpha) {
          compositePixel(px, lampColor, body * style.bodyBaseAlpha);
        }
        if (bodyShadow > 0) {
          compositePixel(px, bodyShadowColor, bodyShadow * style.bodyShadowAlpha);
        }
        compositePixel(
          px,
          highlightColor(lampColor, style.highlightAmount),
          body * style.bodyAlpha
        );
        if (highlightDisk > 0) {
          compositePixel(px, FRAME_GLOSS, highlightDisk * style.highlightAlpha);
        }
        if (core > 0) {
          compositePixel(px, FRAME_GLOSS, core * style.coreAlpha);
        }
        compositePixel(px, ringColor, clamp(ring, 0, 1) * style.ringAlpha);
        compositePixel(px, FRAME_GLOSS, shine * style.shineAlpha);
      }

      pixels[index] = px[0];
      pixels[index + 1] = px[1];
      pixels[index + 2] = px[2];
      pixels[index + 3] = px[3];
    }
  }

  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * stride, y * stride + stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    createChunk("IHDR", ihdr),
    createChunk("IDAT", compressed),
    createChunk("IEND", Buffer.alloc(0))
  ]);
}

const variants = [squareVariant(), macosVariant()];

for (const variant of variants) {
  await fs.mkdir(variant.outputDir, { recursive: true });

  for (const state of STATES) {
    const rgba = Buffer.from(createStateImage(state, variant));
    const png = encodePng(variant.width, variant.height, rgba);
    await fs.writeFile(path.join(variant.outputDir, `${state}.png`), png);
  }
}

process.stdout.write(
  `generated tray state icons in ${OUTPUT_DIR} and ${MACOS_OUTPUT_DIR}\n`
);
