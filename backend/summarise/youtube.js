const YT_API = "https://www.googleapis.com/youtube/v3";

function monthsAgoISO(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

export async function searchVideosByPerson(name, { max = 6, months = 6 } = {}) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");

  const params = new URLSearchParams({
    key,
    part: "snippet",
    q: name,
    type: "video",
    order: "relevance",
    maxResults: String(Math.min(max * 3, 25)),
    publishedAfter: monthsAgoISO(months),
    safeSearch: "none",
    videoEmbeddable: "true",
  });

  const res = await fetch(`${YT_API}/search?${params}`);
  if (!res.ok) throw new Error(`youtube search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const items = (data.items || [])
    .filter(i => i.id?.videoId)
    .map(i => ({
      videoId: i.id.videoId,
      url: `https://youtu.be/${i.id.videoId}`,
      title: i.snippet?.title || "",
      channelTitle: i.snippet?.channelTitle || "",
      publishedAt: i.snippet?.publishedAt || "",
      description: i.snippet?.description || "",
    }));

  return items.slice(0, max);
}

export async function getVideoMetadata(videoIds) {
  if (!videoIds.length) return {};
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");

  const params = new URLSearchParams({
    key,
    part: "contentDetails,statistics",
    id: videoIds.join(","),
  });

  const res = await fetch(`${YT_API}/videos?${params}`);
  if (!res.ok) throw new Error(`youtube videos failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const out = {};
  for (const item of data.items || []) {
    out[item.id] = {
      durationSeconds: parseISODuration(item.contentDetails?.duration),
      viewCount: Number(item.statistics?.viewCount || 0),
    };
  }
  return out;
}

function parseISODuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, h, mm, s] = m;
  return (Number(h || 0) * 3600) + (Number(mm || 0) * 60) + Number(s || 0);
}
