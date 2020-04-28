import { App, IpcMain, Shell, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { ArchiveManager } from './javascripts/main/archiveManager';
import { createExtensionsServer } from './javascripts/main/extServer';
import { buildIndexFile } from './javascripts/main/indexBuilder';
import { MenuManager } from './javascripts/main/menus';
import { isLinux, isMac, isWindows } from './javascripts/main/platforms';
import { Store, StoreKeys } from './javascripts/main/store';
import { AppName, initializeStrings } from './javascripts/main/strings';
import { isDev } from './javascripts/main/utils';
import { createWindowState, WindowState } from './javascripts/main/window';
import { IpcMessages } from './javascripts/shared/ipcMessages';

export interface AppState {
  readonly store: Store;
  readonly startUrl: string;
  readonly webRoot: string;
  readonly extensionsServerAddress: Promise<string>;
  isPrimaryInstance: boolean;
  willQuitApp: boolean;

  windowState?: WindowState;
}

export function initializeApplication(
  app: App,
  ipcMain: IpcMain,
  shell: Shell
) {
  app.name = AppName;
  app.allowRendererProcessReuse = true;

  const isPrimaryInstance = app.requestSingleInstanceLock();

  const webRoot =
    'APP_RELATIVE_PATH' in process.env
      ? path.join(__dirname, process.env.APP_RELATIVE_PATH as string)
      : __dirname;

  const startUrl = path.join(app.getPath('userData'), 'index.html');

  const state: AppState = {
    store: new Store(app.getPath('userData')),
    startUrl,
    webRoot,
    extensionsServerAddress: initializeExtensionsServer(startUrl, webRoot),
    isPrimaryInstance,
    willQuitApp: false,
  };

  state.extensionsServerAddress.catch((error) => {
    dialog.showMessageBoxSync({
      message: error.toString(),
    });
    app.quit();
  });

  registerSingleInstanceHandler(app, state);
  registerAppEventListeners({ app, ipcMain, shell, state });

  if (isDev()) {
    /** Expose the app's state as a global variable for debugging purposes */
    (global as any).appState = state;
  }
}

async function initializeExtensionsServer(
  startUrl: string,
  webRoot: string
): Promise<string> {
  const hostNamePromise = createExtensionsServer();
  const hostName = await hostNamePromise;
  await fs.promises.writeFile(
    startUrl,
    buildIndexFile({ hostName, baseUrl: webRoot }),
    'utf-8'
  );
  return hostName;
}

function registerSingleInstanceHandler(
  app: Electron.App,
  appState: Pick<AppState, 'windowState'>
) {
  app.on('second-instance', () => {
    /* Someone tried to run a second instance, we should focus our window. */
    const window = appState.windowState?.window;
    if (window) {
      if (!window.isVisible()) {
        window.show();
      }
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });
}

function registerAppEventListeners(args: {
  app: Electron.App;
  ipcMain: Electron.IpcMain;
  shell: Shell;
  state: AppState;
}) {
  const { app, state } = args;

  app.on('window-all-closed', () => {
    if (!isMac()) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    state.willQuitApp = true;
  });

  app.on('activate', () => {
    const windowState = state.windowState;
    if (!windowState) return;
    windowState.window.show();
    windowState.updateManager.checkForUpdate();
  });

  app.on('ready', () => {
    if (!state.isPrimaryInstance) {
      console.warn('Quiting app and focusing existing instance.');
      app.quit();
      return;
    }

    finishApplicationInitialization(args);
  });
}

async function finishApplicationInitialization({
  app,
  ipcMain,
  shell,
  state,
}: {
  app: App;
  ipcMain: IpcMain;
  shell: Shell;
  state: AppState;
}) {
  initializeStrings(app.getLocale());
  const windowState = createWindowState({
    shell,
    appState: state,
    appLocale: app.getLocale(),
    teardown() {
      state.windowState = undefined;
    },
  });
  state.windowState = windowState;
  registerIpcEventListeners(
    ipcMain,
    state,
    windowState.menuManager,
    windowState.archiveManager
  );

  if (
    (isWindows() || isLinux()) &&
    state.windowState.trayManager.shouldMinimizeToTray()
  ) {
    state.windowState.trayManager.createTrayIcon();
  }

  await state.extensionsServerAddress;
  windowState.window.loadURL(state.startUrl);
}

function registerIpcEventListeners(
  ipcMain: Electron.IpcMain,
  state: Pick<AppState, 'store' | 'extensionsServerAddress'>,
  menuManager: MenuManager,
  archiveManager: ArchiveManager
) {
  ipcMain.on(IpcMessages.DisplayAppMenu, () => {
    menuManager.popupMenu();
  });

  ipcMain.on(IpcMessages.InitialDataLoaded, () => {
    archiveManager.beginBackups();
  });

  ipcMain.on(IpcMessages.MajorDataChange, () => {
    archiveManager.performBackup();
  });

  ipcMain.handle(
    IpcMessages.ExtensionsServerAddress,
    () => state.extensionsServerAddress
  );

  ipcMain.handle(IpcMessages.UseSystemMenuBar, () =>
    state.store.get(StoreKeys.UseSystemMenuBar)
  );

  ipcMain.handle(IpcMessages.WebRoot, () => {
    console.log();
    if ('APP_RELATIVE_PATH' in process.env) {
      return path.join(
        'file://',
        __dirname,
        process.env.APP_RELATIVE_PATH as string
      );
    } else {
      return path.join('file://', __dirname);
    }
  });
}
