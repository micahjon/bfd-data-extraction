const fs = require('fs');
const childProcess = require('child_process');
const rimraf = require('rimraf');
const { chromium } = require('playwright');

const config = require('./config');

module.exports = async (urlsToProcess, thumbnailFolder, log) => {
  const useGPU = true; // Use native device GPU instead of SwiftShader
  const isHeadless = true; // Headless or windowed mode
  const isDebug = false;
  const startTime = Date.now();

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
    const queuedProjects = urlsToProcess.map(({ url, isThumbTransparent }, index) => ({ index: index + 1, url, isThumbTransparent }));
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
      const { url, isThumbTransparent, index } = project;
      const fileName = url.split('/').pop();
      log(`${index} / ${urlsToProcess.length} Opening project...`, fileName);

      isOpeningProject = true;
      let result;
      try {
        result = await openProjectAndGenerateThumbnail({
          page,
          isDebug,
          bfdUrl: url,
          isThumbTransparent,
          isHeadless,
          useGPU,
          projectDescription: `${index} / ${urlsToProcess.length}`,
          log,
          thumbnailFolder,
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
  page, isDebug, isHeadless, useGPU, bfdUrl, projectDescription, log, thumbnailFolder, isThumbTransparent,
}) {

  if (!bfdUrl) throw new Error('BFD path/URL missing');

  const startTime = Date.now();

  // Open BFD file
  const bfdFileName = bfdUrl.split('/').pop();
  const startTimeFetchingProject = Date.now();

  const bfdVersion = await page.$eval('#open_project_menu', (el, args) => new Promise((resolve, reject) => {
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
      )
      return resolve(parseInt(bfdObject.version) || 1);

    });

  }), { url: bfdUrl });

  const timeFetchingProject = Date.now() - startTimeFetchingProject;

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

  // Get project text, width & height
  const { text, projectWidth, projectHeight, sectionID, sourceTemplateID } = await page.$eval('#open_project_menu', () => {
    const { projectVO } = BFN.AppModel.sectionValue(BFN.PhotoEditorModel, BFN.CollageMakerModel, BFN.DesignerModel);
    const text = projectVO.transformLabels
      .map(label => label.labelText)
      .map(str => str.replace(/\s+/g, ' ').trim())
      .filter(str => str && !BFN.FabricManager.isDefaultText(str))
      .join(' ')
      .slice(0, 1000);
    const { projectWidth, projectHeight, sourceTemplateID } = projectVO;
    const sectionID = projectVO.section;
    return Promise.resolve({ text, projectWidth, projectHeight, sectionID, sourceTemplateID });
  });

  // Generate and download thumbnail
  const { extension: thumbnailExtension, transparencyMismatch } = await page.$eval('#open_project_menu', (el, args) => {
    console.log('Generating high quality thumbnail...');

    //
    // Modified version of BFN.ProjectManager.createThumbnail
    // - Always creates high quality thumbnail (JPG or PNG is passed in)
    // - Set up savePreviewBlob() to download the Blob
    //

    const { isAvailable, reason } = BFN.ProjectManager.checkThumbnailAvailability(args.sectionID);
    if (!isAvailable) return Promise.reject(reason);

    let texture;
    switch (args.sectionID) {
      case 'editor':
        texture = BFN.PhotoEditorCanvas.getFlattenedImage();
        break;
      case 'collage':
        texture = BFN.CollageMakerCanvas.getFlattenedImage();
        break;
      case 'designer':
        texture = BFN.DesignerCanvas.getFlattenedImage();
        break;
    }
    if (!texture) return Promise.reject('no_flattened_image');

    const aspectRatio = texture.width / texture.height;

    // Like aspect ratio, but always >= 1
    const sideRatio = aspectRatio >= 1 ? aspectRatio : 1 / aspectRatio;

    // Create a thumbnail such that it's shortest side is at least 720 pixels
    // if possible (but don't up-scale project)
    const maxSideLength = Math.round(720 * sideRatio);

    const [thumbWidth, thumbHeight] = BFN.TextureUtils.getScaledDimensions(texture, { maxWidth: maxSideLength, maxHeight: maxSideLength });

    // Don't resize if the texture is already the right size (e.g. for small projects)
    const thumbTexture = texture.width === thumbWidth && texture.height === thumbHeight
      ? texture
      : BFN.Util.getThumbTexture(texture, Math.max(thumbWidth, thumbHeight));

    const quality = 1;

    const isProjectTransparent = BFN.Util.isTransparent(thumbTexture);

    // Allow transparency to be overriden to match prior thumbnail
    const isTransparent = typeof args.isThumbTransparent === 'boolean'
      ? args.isThumbTransparent
      : isProjectTransparent;

    const result = BFN.TextureUtils.textureToBlob(thumbTexture, { isTransparent, quality })
      .then((blob) => {
        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const fileName = `thumbnail.${extension}`;
        window.savePreviewBlob = () => {
          saveAs(blob, fileName);
          return true;
        };
        return { extension, transparencyMismatch: args.isThumbTransparent === !isProjectTransparent };
      });

    texture.destroyGC(true);
    thumbTexture.destroyGC(true);

    return result;

  }, { isThumbTransparent, sectionID });

  const [download] = await Promise.all([
    page.waitForEvent('download'), // wait for download to start
    page.waitForFunction('savePreviewBlob()'),
  ]);

  const path = await download.path();
  let thumbFileName;
  if (path) {
    thumbFileName = `${bfdFileName.replace(/\.bfd/, `.bfd_thumb_v1.${thumbnailExtension}`)}`;
    fs.copyFileSync(path, `${thumbnailFolder}/${thumbFileName}`);
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
    sectionID,
    version: bfdVersion,
    sourceTemplateID: sourceTemplateID || '',
    transparencyMismatch,
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
