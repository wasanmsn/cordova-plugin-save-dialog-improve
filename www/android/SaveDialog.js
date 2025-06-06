let exec = require("cordova/exec");
let {keep: keepBlob, get: getBlob, clear: clearBlob} = require("./BlobKeeper");
let moduleMapper = require("cordova/modulemapper");
let FileReader = moduleMapper.getOriginalSymbol(window, "FileReader") || window.FileReader;

function blobToArrayBuffer(blob) {
    // Using FileReader.readAsArrayBuffer() until Blob.arrayBuffer() is widely supported
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(reader.error);
        };
        reader.onabort = () => {
            reject("Blob reading has been aborted");
        };
        reader.readAsArrayBuffer(blob);
    });
}

function asyncExec(action, ...args) {
    return new Promise((resolve, reject) => {
        exec(resolve, reject, "SaveDialog", action, args);
    });
}

// Transfer file contents to the plugin chunk by chunk to overcome the limitation on the size of data that can be
// converted to an array buffer, serialized and passed to the native Java component (see PR #2).
async function addChunks(blob) {
    let getBlobChunks = function* () {
        const CHUNK_SIZE = 1024 ** 2; // 1 MB
        let transferredLength = 0;
        while (transferredLength < blob.size) {
            yield blob.slice(transferredLength, transferredLength + CHUNK_SIZE);
            transferredLength += CHUNK_SIZE;
        }
        return null;
    };
    for (let blobChunk of getBlobChunks()) {
        let arrayBufferChunk = await blobToArrayBuffer(blobChunk);
        await asyncExec("addChunk", arrayBufferChunk);
    }
}

function checkFileName(name) {
    let isExist = false;
    window.resolveLocalFileSystemURL(name,() => {
        isExist = true;
    },
    () => {
        isExist = false;
    }
    )
    if(isExist){
        const fileObj = extractFileName(name);
        const newFileName = `${fileObj.base}(${fileObj.counter}).${fileObj.ext}`
        return checkFileName(newFileName);
    }
    return name;

}

function extractFileName(fileName) {
    let baseName;
    let extension = "";
    let counter = extractNumberFromLastParentheses(fileName);
    let dotIndex = fileName.lastIndexOf(".");
    if (dotIndex != -1) {
        baseName = fileName.substring(0, dotIndex);
        extension = fileName.substring(dotIndex);
    } else {
        return {base: fileName, ext: "pdf", counter: 0};
    }
    return {base: baseName, ext: extension, counter: counter};
}

function extractNumberFromLastParentheses(str) {
  // Find all matches of numbers inside parentheses
  const regex = /\((\d+)\)/g;
  let matches = [];
  let match;
  
  // Collect all matches
  while ((match = regex.exec(str)) !== null) {
    matches.push({
      fullMatch: match[0],
      number: parseInt(match[1], 10),
      index: match.index
    });
  }
  
  // If we found matches, return the number from the last one
  if (matches.length > 0) {
    // Sort by index to get the last occurrence
    matches.sort((a, b) => a.index - b.index);
    return matches[matches.length - 1].number;
  }
  
  // If no match is found, return null
  return 0;
}

module.exports = {
    async saveFile(blob, name = "") {
        try {
            await keepBlob(blob); // see the “resume” event handler below
            let uri = await asyncExec("locateFile", blob.type || "application/octet-stream", "moodeng");
            uri = checkFileName(uri)
            await addChunks(blob);
            return await asyncExec("saveFile", uri);
        } catch (reason) {
            return Promise.reject(reason);
        } finally {
            clearBlob();
        }
    }
};

// If Android OS has destroyed the Cordova Activity in background, try to complete the Save operation
// using the URI passed in the payload of the “resume” event and the blob stored by the BlobKeeper.
// https://cordova.apache.org/docs/en/11.x/guide/platforms/android/plugin.html#launching-other-activities
document.addEventListener("resume", async  ({pendingResult = {}}) => {
    if (pendingResult.pluginServiceName !== "SaveDialog") {
        return;
    }
    if (pendingResult.pluginStatus !== "OK" || !pendingResult.result) {
        clearBlob();
        return;
    }
    let blob = await getBlob();
    if (blob instanceof Blob) {
        try {
            await addChunks(blob);
            await asyncExec("saveFile", pendingResult.result);
        } catch (reason) {
            console.warn("[SaveDialog]", reason);
        }
    }
    clearBlob();
}, false);
