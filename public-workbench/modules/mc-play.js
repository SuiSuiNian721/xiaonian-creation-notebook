import {mount as mountView} from '../mc-play-view.js';
import {mountComponentModule} from '../component-packages.js';
export const mount=(root,ctx)=>mountComponentModule(root,ctx,'mc-play',mountView);
