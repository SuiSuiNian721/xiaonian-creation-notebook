import {mount as mountView} from '../training-studio.js';
import {mountComponentModule} from '../component-packages.js';
export const mount=(root,ctx)=>mountComponentModule(root,ctx,'training',mountView);
