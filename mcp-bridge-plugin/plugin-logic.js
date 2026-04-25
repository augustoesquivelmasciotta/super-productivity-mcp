(function () {
  function ts() {
    return new Date().toISOString();
  }

  function log(level, message, extra) {
    var prefix = "[MCP Bridge " + ts() + "]";
    if (extra === undefined) {
      console[level](prefix + " " + message);
      return;
    }
    console[level](prefix + " " + message, extra);
  }

  log("log", "Loading plugin logic...");

  function initPlugin(api) {
    log("log", "Initializing with API...");

    // Connect to the MCP server (same host; PORT must match server, e.g. 3996)
    var socket = io("http://127.0.0.1:3996", {
      reconnectionDelayMax: 10000,
      transports: ["websocket", "polling"],
      upgrade: true,
      timeout: 120000,
      transportOptions: {
        polling: {
          requestTimeout: 120000,
        },
      },
    });

    function currentTransport() {
      return socket.io && socket.io.engine && socket.io.engine.transport
        ? socket.io.engine.transport.name
        : "unknown";
    }

    socket.on("connect", function () {
      log(
        "log",
        "Connected to MCP Server socketId=" + socket.id + " transport=" + currentTransport(),
      );
      // Heartbeat: emit version stamp on connect. Server logs this so we can
      // always tell which plugin code is actually running. Cheap; do not remove.
      socket.emit("event:debug:startup", { version: "1.0.6", socketId: socket.id });
    });

    socket.on("disconnect", function (reason, details) {
      log(
        "warn",
        "Disconnected from MCP Server reason=" + reason + " transport=" + currentTransport(),
        details,
      );
    });

    socket.on("connect_error", function (err) {
      log("error", "Connection error", {
        message: err && err.message,
        description: err && err.description,
        context: err && err.context,
        transport: currentTransport(),
      });
    });

    socket.io.on("open", function () {
      log("log", "Socket.IO manager open transport=" + currentTransport());
    });

    socket.io.on("close", function (reason, details) {
      log("warn", "Socket.IO manager close reason=" + reason, details);
    });

    socket.io.on("error", function (err) {
      log("error", "Socket.IO manager error", err);
    });

    socket.io.on("reconnect_attempt", function (attempt) {
      log("warn", "Socket.IO reconnect attempt=" + attempt + " transport=" + currentTransport());
    });

    socket.io.on("reconnect", function (attempt) {
      log("log", "Socket.IO reconnected after attempts=" + attempt + " transport=" + currentTransport());
    });

    socket.io.on("reconnect_error", function (err) {
      log("error", "Socket.IO reconnect error", err);
    });

    socket.io.on("reconnect_failed", function () {
      log("error", "Socket.IO reconnect failed");
    });

    if (socket.io.engine) {
      socket.io.engine.on("upgrade", function () {
        log("log", "Engine transport upgraded transport=" + currentTransport());
      });

      socket.io.engine.on("upgradeError", function (err) {
        log("error", "Engine transport upgrade error", err);
      });

      socket.io.engine.on("close", function (reason) {
        log("warn", "Engine close reason=" + reason + " transport=" + currentTransport());
      });

      socket.io.engine.on("error", function (err) {
        log("error", "Engine error", err);
      });
    }

    // --- Command Handlers (Server -> Plugin) ---

    socket.on("tasks:get", function (data, callback) {
      api.getTasks()
        .then(function (tasks) { callback(tasks); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:getCurrent", function (data, callback) {
      api.getCurrentContextTasks()
        .then(function (tasks) { callback(tasks); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:getArchived", function (data, callback) {
      var fn = api.getArchivedTasks;
      if (typeof fn !== "function") {
        callback({ error: "getArchivedTasks is not available on this Super Productivity version" });
        return;
      }
      fn.call(api)
        .then(function (tasks) { callback(tasks); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:create", function (taskData, callback) {
      var postCreateUpdates = {};
      if (taskData.tagIds !== undefined) postCreateUpdates.tagIds = taskData.tagIds;
      if (taskData.dueWithTime !== undefined) postCreateUpdates.dueWithTime = taskData.dueWithTime;
      if (taskData.remindAt !== undefined) postCreateUpdates.remindAt = taskData.remindAt;

      // Strip fields api.addTask ignores/mishandles — apply via updateTask instead
      var addTaskData = {};
      Object.keys(taskData).forEach(function (k) {
        if (k !== "tagIds" && k !== "dueWithTime" && k !== "remindAt") {
          addTaskData[k] = taskData[k];
        }
      });

      log("log", "tasks:create postCreateUpdates=" + JSON.stringify(postCreateUpdates));

      api.addTask(addTaskData)
        .then(function (taskId) {
          log("log", "addTask resolved taskId=" + taskId);
          if (Object.keys(postCreateUpdates).length === 0) {
            return Promise.resolve(taskId);
          }
          // Delay 200ms so SP commits the new task to its NgRx store
          // before updateTask is dispatched (race condition otherwise)
          return new Promise(function (resolve, reject) {
            setTimeout(function () {
              api.updateTask(taskId, postCreateUpdates)
                .then(function (updateResult) {
                  log("log", "updateTask resolved taskId=" + taskId + " result=" + JSON.stringify(updateResult));
                  resolve(taskId);
                })
                .catch(reject);
            }, 200);
          });
        })
        .then(function (taskId) { callback(taskId); })
        .catch(function (err) {
          log("error", "tasks:create error: " + (err && (err.message || String(err))));
          callback({ error: err.message || String(err) });
        });
    });

    socket.on("tasks:update", function (data, callback) {
      log("log", "tasks:update taskId=" + data.taskId + " updates=" + JSON.stringify(data.updates));
      api.updateTask(data.taskId, data.updates)
        .then(function (result) {
          log("log", "tasks:update resolved taskId=" + data.taskId + " result=" + JSON.stringify(result));
          callback({ success: true });
        })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:delete", function (data, callback) {
      api.deleteTask(data.taskId)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:batch", function (data, callback) {
      // batchUpdateForProject expects the full request { projectId, operations } from the MCP server.
      api.batchUpdateForProject(data)
        .then(function (result) { callback(result); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tasks:reorder", function (data, callback) {
      var fn = api.reorderTasks;
      if (typeof fn !== "function") {
        callback({ error: "reorderTasks is not available on this Super Productivity version" });
        return;
      }
      fn.call(api, data.taskIds, data.contextId, data.contextType)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("projects:get", function (data, callback) {
      api.getAllProjects()
        .then(function (projects) { callback(projects); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("projects:create", function (projectData, callback) {
      api.addProject(projectData)
        .then(function (projectId) { callback(projectId); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("projects:update", function (data, callback) {
      api.updateProject(data.projectId, data.updates)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tags:get", function (data, callback) {
      api.getAllTags()
        .then(function (tags) { callback(tags); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tags:create", function (tagData, callback) {
      api.addTag(tagData)
        .then(function (tagId) { callback(tagId); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tags:update", function (data, callback) {
      api.updateTag(data.tagId, data.updates)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("tags:delete", function (data, callback) {
      api.deleteTag(data.tagId)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("ui:notify", function (config, callback) {
      api.showNotification(config.message, config.type || "INFO", config.duration)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("ui:showSnack", function (config, callback) {
      var msg = config.msg != null ? config.msg : config.message;
      api.showSnack(msg, config.type || "INFO")
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("ui:openDialog", function (config, callback) {
      api.showDialog(config)
        .then(function (result) { callback(result); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    // Counters
    socket.on("counters:get", function (data, callback) {
      api.getAllCounters()
        .then(function (counters) { callback(counters); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("counter:get", function (data, callback) {
      api.getCounter(data.id)
        .then(function (counter) { callback(counter); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("counter:set", function (data, callback) {
      api.setCounter(data.id, data.value)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("counter:increment", function (data, callback) {
      var p = data.incrementBy !== undefined && data.incrementBy !== null
        ? api.incrementCounter(data.id, data.incrementBy)
        : api.incrementCounter(data.id);
      p.then(function (result) { callback(result); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("counter:decrement", function (data, callback) {
      var p = data.decrementBy !== undefined && data.decrementBy !== null
        ? api.decrementCounter(data.id, data.decrementBy)
        : api.decrementCounter(data.id);
      p.then(function (result) { callback(result); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("counter:delete", function (data, callback) {
      api.deleteCounter(data.id)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    // Persisted Data
    socket.on("persisted-data:load", function (data, callback) {
      api.getPersistedData(data.key)
        .then(function (result) { callback(result); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("persisted-data:save", function (data, callback) {
      api.setPersistedData(data.key, data.data)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    // Misc
    socket.on("config:get", function (data, callback) {
      api.getConfig()
        .then(function (config) { callback(config); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("actions:dispatch", function (data, callback) {
      api.dispatchAction(data.action, data.payload)
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    socket.on("window:focus", function (data, callback) {
      api.focusWindow()
        .then(function () { callback({ success: true }); })
        .catch(function (err) { callback({ error: err.message || String(err) }); });
    });

    // --- Event Hooks (Plugin -> Server) ---
    //
    // We register four hooks. The first three give the listener enough
    // information to maintain an accurate `{taskId → scheduled state}` cache
    // across all common UI/MCP operations. The fourth (action filtered)
    // closes a known gap in taskUpdate.
    //
    // 1. taskUpdate -> event:taskUpdate
    //    Fires for unscheduleTask, scheduleTaskWithTime, reScheduleTaskWithTime,
    //    planTaskForDay, transferTask, moveToOtherProject, generic updateTask.
    //    Does NOT fire for [Task Shared] planTasksForToday (drag to Today).
    //    Why this hook (not anyTaskUpdate): anyTaskUpdate$ effect only listens
    //    to addTask/updateTask/deleteTask, missing all the scheduling actions
    //    above. Empirically verified 2026-04-25.
    //
    // 2. taskCreated -> event:taskCreated
    //    Fires on every new task creation (UI or MCP). Hydrates the cache so
    //    transitions on freshly-created tasks are detected correctly.
    //
    // 3. taskDelete -> event:taskDelete
    //    Fires on task deletion (single or batch). Cleans the cache so deleted
    //    task IDs don't linger as zombies.
    //
    // 4. action -> event:taskScheduled (FILTERED)
    //    Fires for every redux action in SP — way too noisy to forward unfiltered
    //    (during the all-hooks experiment we saw ~30 events from <1min of normal
    //    UI use: SetSelectedTask, layout panel toggles, work-context switches,
    //    tag updates, etc.). Plugin filters to a strict whitelist before
    //    emitting. Currently the only entry is "[Task Shared] planTasksForToday"
    //    (the drag-to-Today action that taskUpdate misses). Add more entries
    //    here if a future SP version introduces a scheduling action that doesn't
    //    flow through taskUpdate.
    //
    // Channel naming kept stable so the server's existing socket.on listeners
    // don't have to be updated for every new hook we add.
    var hookRegistration = { ok: [], err: {} };
    function tryRegister(hookName, fn) {
      try {
        api.registerHook(hookName, fn);
        hookRegistration.ok.push(hookName);
      } catch (err) {
        hookRegistration.err[hookName] = String(err && err.message || err);
      }
    }

    tryRegister("taskUpdate", function (payload) {
      socket.emit("event:taskUpdate", payload);
    });
    tryRegister("taskCreated", function (payload) {
      socket.emit("event:taskCreated", payload);
    });
    tryRegister("taskDelete", function (payload) {
      socket.emit("event:taskDelete", payload);
    });

    // Whitelist of redux action types we want forwarded. Keep tight.
    var FORWARDED_ACTIONS = {
      "[Task Shared] planTasksForToday": true,
    };
    tryRegister("action", function (payload) {
      var type = payload && payload.action && payload.action.type;
      if (type && FORWARDED_ACTIONS[type]) {
        socket.emit("event:taskScheduled", payload);
      }
    });

    // Lightweight summary so the server log shows which hooks SP accepted.
    // Helps diagnose breakage on SP version upgrades.
    setTimeout(function () {
      socket.emit("event:debug:hooksRegistered", hookRegistration);
    }, 1500);
  }

  // Init
  if (typeof PluginAPI !== "undefined") {
    initPlugin(PluginAPI);
  } else {
    console.error("MCP Bridge: PluginAPI not found!");
  }
})();
