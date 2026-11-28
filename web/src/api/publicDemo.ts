export const isPublicDemo = import.meta.env.VITE_MRV_PUBLIC_DEMO === '1';

const storageKey = 'mrv_public_demo_playlist';
const playlistUrl = `${import.meta.env.BASE_URL}playlist.json`;

async function readPlaylist() {
  const saved = localStorage.getItem(storageKey);
  return saved ? JSON.parse(saved) : (await fetch(playlistUrl)).json();
}

export async function publicDemoResponse(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0];
  const method = init?.method ?? 'GET';

  if (path === '/api/playlist') {
    if (method === 'GET') return Response.json(await readPlaylist());
    const { data } = JSON.parse(String(init?.body));
    localStorage.setItem(storageKey, JSON.stringify(data));
    return Response.json({ status: 'ok' });
  }

  if (method === 'GET') {
    if (path.startsWith('/api/lyrics/')) return Response.json({ lines: [] });
    if (path === '/api/status') {
      return Response.json({
        is_downloading: false, is_rendering: false, queue_count: 0, current_song: '', logs: [], progress_percent: 0,
      });
    }
    if (path === '/api/projects') {
      const playlist = await readPlaylist();
      return Response.json({ active: 'demo', projects: [{ id: 'demo', name: playlist.output_sequence_name }] });
    }
    if (path === '/api/bilibili/status') {
      return Response.json({ logged_in: false, uname: '', is_vip: false, vip_label: '' });
    }
    if (path === '/api/netease_audio/config') {
      return Response.json({ configured: false, api_url: '', api_key_masked: '', default_quality: '', qualities: [] });
    }
  }

  if (path === '/api/logs/clear') return Response.json({ status: 'ok' });

  return Response.json({ detail: '此功能需要本地运行 MRV-02 服务。' }, { status: 501 });
}
