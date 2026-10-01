import { useState } from 'react';
import { MyImages } from './MyImages';
import { Pipeline } from './Pipeline';

type Tab = 'images' | 'pipeline';

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#pipeline' ? 'pipeline' : 'images'));
  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };
  return (
    <div className="app">
      <header>
        <h1>Media pipeline</h1>
        <nav>
          <button className={tab === 'images' ? 'active' : ''} onClick={() => select('images')}>My images</button>
          <button className={tab === 'pipeline' ? 'active' : ''} onClick={() => select('pipeline')}>Pipeline</button>
        </nav>
      </header>
      {tab === 'images' ? <MyImages /> : <Pipeline />}
    </div>
  );
}
