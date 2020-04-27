const fs = require('fs');
const childProcess = require('child_process');
const rimraf = require('rimraf');
const { chromium } = require('playwright');

const config = require('./config');

module.exports = async (instanceID, urlsToProcess) => {
  const useGPU = true; // Use native device GPU instead of SwiftShader
  const isHeadless = true; // Headless or windowed mode
  const isDebug = false;
  const startTime = Date.now();
  const log = (...args) => console.log(`${instanceID} >`, ...args);

  log(`Processing ${urlsToProcess.length} BFD URLs...`);

  const cacheDirectory = './.headless-chrome-cache';

  const chromeArgs = [
    '--force-device-scale-factor=1',
    '--disable-infobars=true',
    useGPU ? '--use-gl=any' : '--use-gl=swiftshader',
    `--disk-cache-dir=${cacheDirectory}`,
  ];
  const browser = await chromium.launch({
    headless: isHeadless,
    args: chromeArgs,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
  });

  // Add testing flags
  await context.addCookies([{
    name: 'testing_flags',
    value: 'disable_webgl_performance_check, disable_indexeddb',
    domain: config.domain,
    path: '/',
  }]);

  // Open page
  const page = await context.newPage();
  await page.goto(config.createURL);

  // Wait for first section to open
  await page.waitForFunction('window.BFN && BFN.openedSections.length');

  if (isDebug) {
    // Log anything in the console
    page.on('console', (msg) => {
      log(`Console > ${msg.args().join('\t')}`);
    });
  }

  return new Promise((resolveQueue) => {

    // Start a preload queue. Projects will be requested (and stored in cache)
    // and then opened when browser is ready
    // Each object in queue is of the form: { url <string>, index: <number> }
    // where index starts at 1 (just used for logging)
    const inParallel = 5;
    const queuedProjects = urlsToProcess.map((url, index) => ({ index: index + 1, url }));
    const loadingProjects = [];
    const preloadedProjects = [];

    const missingProjects = []; // Projects that could not be loaded
    const fontSwapProjects = []; // Projects that required a font swap
    const unopenedProjects = []; // Projects that could not be opened
    const openedProjects = []; // Projects that were successfully opened

    for (let i = 0; i < inParallel; i++) {
      setTimeout(preloadNextURL, i * 200);
    }

    function preloadNextURL() {
      if (!queuedProjects.length) return;
      if (loadingProjects.length >= inParallel) return;

      const project = queuedProjects.shift();
      const { url, index } = project;

      loadingProjects.push(project);

      const preloadStartTime = Date.now();
      const fileName = url.split('/').pop();

      let timeout;
      reportLongLoadTime();

      // Preload this URL
      page.$eval('#open_project_menu', (el, args) => new Promise((resolve, reject) => {
        BeFunky.request(args.url, { responseType: 'blob' }, ({ response: blob, error }) => {
          if (!error) return resolve(blob.size);

          // Try one more time
          BeFunky.request(args.url, { responseType: 'blob' }, ({ response: secondBlob, error: secondError }) => {
            if (!secondError) return resolve(secondBlob.size);
            return reject(secondError);
          });
        });
      }), { url })
        .then((blobSize) => {
          log(`Preloaded ${index} / ${urlsToProcess.length} in ${toSeconds(Date.now() - preloadStartTime)}s`, fileName, formatBytes(blobSize));

          // Add size (in kb) to project
          Object.assign(project, { sizeInKB: Math.round(blobSize / 1024) });

          // Move from loadingProjects -> preloadedProjects
          if (loadingProjects.indexOf(project) === -1) throw new Error('Can\'t find loading URL');
          loadingProjects.splice(loadingProjects.indexOf(project), 1);
          preloadedProjects.push(project);
        })
        .catch((error) => {
          log(`\tFailed to preload project ${index} / ${urlsToProcess.length} on second attempt.`, url, error.message);

          // Move from loadingProjects -> missingProjects
          if (loadingProjects.indexOf(project) === -1) throw new Error('Can\'t find loading URL');
          loadingProjects.splice(loadingProjects.indexOf(project), 1);

          Object.assign(project, { error });
          missingProjects.push(project);
        })
        .then(() => {
          clearTimeout(timeout);

          if (isDebug && Math.random() > 0.8) logCacheDirectorySize(cacheDirectory);

          // Open next preloaded project (if app is idle)
          openNextProject();

          // Start working on next URL, but prioritize under opening project,
          // which takes longer
          preloadNextURL();
        });

      function reportLongLoadTime() {
        timeout = setTimeout(() => {
          log(`\tProject ${index} / ${urlsToProcess.length} is taking a really long time to load! ${toSeconds(Date.now() - preloadStartTime)}s`, fileName);
          reportLongLoadTime();
        }, 15000);
      }
    }

    // Only open one project at a time
    let isOpeningProject = false;

    // Open each preloaded project
    async function openNextProject() {
      if (isOpeningProject) return;

      // Every project has been attempted
      if (!preloadedProjects.length && !queuedProjects.length && !loadingProjects.length) {
        log('Finished');
        await context.close();
        await browser.close();

        const totalTime = Date.now() - startTime;
        const perBFD = openedProjects.length ? `(${toSeconds(totalTime / openedProjects.length)}s / BFD)` : '';
        const resultText = `Generated thumbnails for ${openedProjects.length} / ${urlsToProcess.length} BFDs in ${toSeconds(totalTime)}s ${perBFD}`;
        log(resultText);
        if (missingProjects.length) {
          log(`${missingProjects.length} projects couldn't be downloaded:`);
          missingProjects.forEach(({ index, url }) => {
            log(`\t${index} / ${urlsToProcess.length} ${url}`);
          });
        }
        if (fontSwapProjects.length) {
          log(`${fontSwapProjects.length} projects had missing/copyrighted fonts:`);
          fontSwapProjects.forEach(({ index, url, fontsToSwap }) => {
            log(`\t${index} / ${urlsToProcess.length} ${url.split('/').pop()} \t${JSON.stringify(fontsToSwap)}`);
          });
        }
        if (unopenedProjects.length) {
          log(`${unopenedProjects.length} projects couldn't be opened:`);
          unopenedProjects.forEach(({ index, url }) => {
            log(`\t${index} / ${urlsToProcess.length} ${url}`);
          });
        }

        return resolveQueue({
          result: resultText,
          // Remove irrelevant index property just used for logging
          openedProjects: openedProjects.map(p => { delete p.index; return p; }),
          missingProjects: missingProjects.map(p => { delete p.index; return p; }),
          fontSwapProjects: fontSwapProjects.map(p => { delete p.index; return p; }),
          unopenedProjects: unopenedProjects.map(p => { delete p.index; return p; }),
        });
      }

      // Projects are still preloading...
      if (!preloadedProjects.length) return;

      // Open next project
      const project = preloadedProjects.shift();
      const { url, index } = project;
      const fileName = url.split('/').pop();
      log(`${index} / ${urlsToProcess.length} Opening project...`, fileName);

      isOpeningProject = true;
      let result;
      try {
        result = await openProjectAndGenerateThumbnail({
          page,
          isDebug,
          bfdUrl: url,
          isHeadless,
          useGPU,
          projectDescription: `${index} / ${urlsToProcess.length}`,
          log,
        });
      } catch (err) {
        log(`!!!\tFailed to open project ${index} / ${urlsToProcess.length}`, fileName, err, '\n');

        Object.assign(project, { error: err });
        unopenedProjects.push(project);
      }
      isOpeningProject = false;

      // Handle projects where the font needs to be swapped
      if (result && result.fontsToSwap) {
        project.fontsToSwap = result.fontsToSwap;
        fontSwapProjects.push(project);
      }
      // Handle successful projects
      if (result && result.thumbURL) {
        Object.assign(project, result);
        openedProjects.push(project);
      }

      if (isDebug && Math.random() > 0.8) logCacheDirectorySize(cacheDirectory);

      // Move on to next project now that app is reset
      openNextProject();
    }

  })


};

async function openProjectAndGenerateThumbnail({
  page, isDebug, isHeadless, useGPU, bfdUrl, projectDescription, log,
}) {

  if (!bfdUrl) throw new Error('BFD path/URL missing');

  const startTime = Date.now();

  // Open BFD file
  const bfdFileName = bfdUrl.split('/').pop();
  const startTimeFetchingProject = Date.now();

  const dimensions = await page.$eval('#open_project_menu', (el, args) => new Promise((resolve, reject) => {
    console.log('Fetching BFD...', args.url);
    BFN.SavedProjectService.getBefunkyBfd(args.url, ({ error, data }) => {
      if (error) {
        BeFunky.logError('Unable to download BFD', error);
        return reject(error);
      }

      const bfdObject = data;
      if (typeof bfdObject !== 'object') {
        BeFunky.logError('data =', data);
        return reject('No BFD object');
      }

      // Open project in appropriate section
      console.log('Opening project');
      BFN.ProjectManager.openProject(
        bfdObject,
        '',
      );

      // Get project dimensions
      const { projectWidth, projectHeight } = bfdObject;

      // Get project text
      const text = bfdObject.transformLabels
        .map(label => label.labelText.replace(/\s+/g, ' ').trim())
        .join(' ')
        .slice(0, 1000);

      return resolve(JSON.stringify({ projectWidth, projectHeight, text }));
    });

  }), { url: bfdUrl });

  const timeFetchingProject = Date.now() - startTimeFetchingProject;

  const { projectWidth, projectHeight, text } = JSON.parse(dimensions);

  // Wait for everything to finish loading
  await waitForLoadingToComplete();

  if (isDebug) {
    await page.screenshot({ path: `${startTime}-2.jpg`, type: 'jpeg', quality: 90 });
  }

  // Handle swapped fonts
  const fontsToSwap = await page.$eval('#open_project_menu', () => {
    if (Object.keys(BFN.ParseBFD.swappedFonts).length) {
      // Don't swap fonts
      BeFunky.getModal().modalElement.querySelector('.button--grey').click();
      return Object.keys(BFN.ParseBFD.swappedFonts);
    }
  });

  if (fontsToSwap) {
    log(`${projectDescription} Fonts need swapped`, bfdFileName, fontsToSwap);
    return { fontsToSwap };
  }

  // Generate and download thumbnail
  const thumbnailExtension = await page.$eval('#open_project_menu', () => {
    console.log('Generating high quality thumbnail...');
    return BFN.ProjectManager.createThumbnail(BFN.AppModel.sectionID, 'blob', true)
      .then((blob) => {
        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const fileName = `thumbnail.${extension}`;
        window.savePreviewBlob = () => {
          saveAs(blob, fileName);
          return true;
        };
        return extension;
      });
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'), // wait for download to start
    page.waitForFunction('savePreviewBlob()'),
  ]);

  const path = await download.path();
  let thumbFileName;
  if (path) {
    thumbFileName = `${Date.now()}-${bfdFileName.replace(/\.bfd/, `.${thumbnailExtension}`)}`;
    fs.copyFileSync(path, `./thumbnails/${thumbFileName}`);
  } else {
    throw 'Failed to download file';
  }

  // Reset app
  await page.$eval('#open_project_menu', () => {
    console.log('Resetting...');
    BFN.UndoManager.reset();
    BeFunky.getModal().modalElement.querySelector('.button--blue').click();
  });

  const totalTime = Date.now() - startTime;
  const processingTime = totalTime - timeFetchingProject;

  // log('Time:', bfdFileName);
  log(`${projectDescription} Thumbnail saved. ${isHeadless ? 'Headless' : 'Windowed'} + ${useGPU ? 'GPU' : 'SwiftShader'}:`, `Processing = ${toSeconds(processingTime)}s. Fetching project = ${toSeconds(timeFetchingProject)}s`);

  return {
    thumbURL: `/thumbnails/${thumbFileName}`,
    projectWidth,
    projectHeight,
    text,
  };

  async function waitForLoadingToComplete() {
    await page.$eval('#open_project_menu', () => {
      return new Promise((resolve) => {
        console.log('Waiting...');
        setTimeout(() => waitSomeMore(resolve), 1000);
      });
      function waitSomeMore(callback) {
        // Wait for load screen to be hidden twice in case we momentarily
        // hide it and don't immediately re-show it during the loading process
        wait(() => {
          if (isLoading()) return waitSomeMore(callback);
          wait(() => {
            if (isLoading()) return waitSomeMore(callback);
            callback();
          });
        });
      }
      function isLoading() {
        return BFN.ProjectManager.projectLoading || BeFunky.isLoadScreenActive();
      }
      function wait(callback) {
        setTimeout(() => {
          BFN.MainUI.addIdleRenderFunction(callback);
        }, 50);
      }
    });
  }


}

function toSeconds(time) {
  return (time / 1000).toFixed(1);
}

/**
 * Render bytes as KB, MB or GB
 * @param {number} bytes
 * @param {number} decimals
 * @returns {string}
 */
function formatBytes(bytes, decimals = 1) {
  if (!bytes) return '0 Bytes';
  const kb = bytes / 1024;
  const mb = kb / 1024;
  const gb = mb / 1024;
  if (gb > 1) return `${gb.toFixed(1)} GB`;
  if (mb > 1) return `${mb.toFixed(1)} MB`;
  return `${kb.toFixed(decimals)} KB`;
}

function logCacheDirectorySize(directory) {
  try {
    log('Cache size:', childProcess.execSync(`du -sh ${directory}`).toString().trim());
  } catch (e) {
    log(`Unable to get cache size: ${e}`);
  }
}
