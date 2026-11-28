import { useEffect, useRef, useState } from 'react';
import { activateProjectApi, createProjectApi, fetchProjectsApi } from '../api/client';
import { useStudioStore } from '../state/useStudioStore';
import { TactileButton } from './ui/TactileButton';

export function ProjectSelector() {
  const { playlist, savePlaylist, status } = useStudioStore();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = typeof playlist.project_id === 'string' ? playlist.project_id : 'default';
  const busy = switching || status.is_downloading || status.is_rendering || status.queue_count > 0;

  useEffect(() => {
    let alive = true;
    fetchProjectsApi().then(data => {
      if (alive) setProjects(data.projects);
    }).catch(() => {});
    return () => { alive = false; };
  }, [active]);

  const changeProject = async (action: () => Promise<unknown>) => {
    setSwitching(true);
    setError('');
    try {
      if (!await savePlaylist({ silent: true })) {
        setError('Save the current project before switching.');
        return;
      }
      await action();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to change project.');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="project-selector">
      {projects.length > 1 && (
        <select className="te-select" aria-label="Video project" value={active} disabled={busy}
          onChange={event => {
            const id = event.currentTarget.value;
            void changeProject(() => activateProjectApi(id));
          }}>
          {projects.map(project => <option key={project.id} value={project.id}>{project.id === active ? playlist.output_sequence_name || project.name : project.name}</option>)}
        </select>
      )}
      <TactileButton size="sm" disabled={busy} onClick={() => {
        setName('');
        setDuplicate(false);
        setError('');
        dialog.current?.showModal();
      }}>+ Project</TactileButton>
      {!dialog.current?.open && error && <span role="alert">{error}</span>}
      <dialog ref={dialog} className="project-create-dialog" aria-labelledby="project-create-title" onClose={() => setError('')}>
        <form onSubmit={event => {
          event.preventDefault();
          void changeProject(() => createProjectApi(name, duplicate));
        }}>
          <h2 id="project-create-title">New Video Project</h2>
          <label>Project name<input className="te-input" required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
          <label><input type="checkbox" checked={duplicate} onChange={event => setDuplicate(event.target.checked)} /> Copy current playlist and edits</label>
          {error && <p role="alert">{error}</p>}
          <div className="project-create-actions">
            <TactileButton disabled={switching} onClick={() => dialog.current?.close()}>Cancel</TactileButton>
            <TactileButton type="submit" disabled={busy || !name.trim()}>Create</TactileButton>
          </div>
        </form>
      </dialog>
    </div>
  );
}
