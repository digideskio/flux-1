/*******************************************************************************
 * @license
 * Copyright (c) 2014 Pivotal Software Inc. and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: Pivotal Software Inc. - initial API and implementation
 ******************************************************************************/

/*global window eclipse:true orion FileReader Blob*/
/*jslint forin:true devel:true*/


/** @namespace The global container for eclipse APIs. */
var eclipse = eclipse || {};

var callbacksCache = {};
var user;
var muteLiveEdit = true;
var editSession;
var serviceRegistry;

var counter = 1;
function generateCallbackId() {
	return counter++;
}

/**
 * An implementation of the file service that understands the Orion 
 * server file API. This implementation is suitable for invocation by a remote plugin.
 */
eclipse.FluxEditor = (function() {
	/**
	 * @class Provides operations on files, folders, and projects.
	 * @name FileServiceImpl
	 */
	function FluxEditor(host, port, userId) {
		this._rootLocation = "flux:http://" + host +":" + port + "/" + userId + "/";
		user = userId;

		this.socket = io.connect(host, {
			port: port
		});
		
		this._resourceUrl = null;
		
		var self = this;
		
		this.socket.on('connect', function() {
//			while (user && !self._connectedToChannel) {
				self.socket.emit('connectToChannel', {
					'channel' : user
				}, function(answer) {
					if (answer.connectedToChannel) {
						self._connectedToChannel = true;
						console.log("EDITOR Connected to FLUX channel: " + user);
					}
				});
//			}
		});
		
		this.socket.on('getResourceResponse', function(data) {
			self._handleMessage(data);				
		});
		
		this.socket.on('contentassistresponse', function(data) {
			self._handleMessage(data);				
		});

		this.socket.on('liveResourceStartedResponse', function(data) {
			self._getResourceData().then(function(resourceMetadata) {
				if (data.username === resourceMetadata.username 
					&& data.project === resourceMetadata.project 
					&& data.resource === resourceMetadata.resource 
					&& data.callback_id !== undefined
					&& resourceMetadata.timestamp === data.savePointTimestamp 
					&& resourceMetadata.hash === data.savePointHash) {
					muteLiveEdit = true;
					self._editorContext.setText(data.liveContent).then(function() {
						muteLiveEdit = false;
					}, function() {
						muteLiveEdit = false;
					});;
				}
			}, function(err) {
				console.log(err);
			});
		});
	
		this.socket.on('liveResourceStarted', function(data) {
			self._getResourceData().then(function(resourceMetadata) {
				if (data.username === resourceMetadata.username 
					&& data.project === resourceMetadata.project 
					&& data.resource === resourceMetadata.resource 
					&& data.callback_id !== undefined
					&& data.hash === resourceMetadata.hash
					&& data.timestamp === resourceMetadata.timestamp) {
		
					self._editorContext.getText().then(function(contents) {
						self.sendMessage('liveResourceStartedResponse', {
							'callback_id'        : data.callback_id,
							'requestSenderID'    : data.requestSenderID,
							'username'           : data.username,
							'project'            : data.project,
							'resource'           : data.resource,
							'savePointTimestamp' : resourceMetadata.timestamp,
							'savePointHash'      : resourceMetadata.hash,
							'liveContent'        : contents
						});
					});
				}
			});
		});
	
		this.socket.on('getLiveResourcesRequest', function(data) {
			self._getResourceData().then(function(resourceMetadata) {
				if (data.username === resourceMetadata.username 
					&& data.callback_id !== undefined
					&& data.project === resourceMetadata.project) {
						
					self.sendMessage('getLiveResourcesResponse', {
						'callback_id'        : data.callback_id,
						'requestSenderID'    : data.requestSenderID,
						'liveEditUnits'      : [{
							'username'           : resourceMetadata.username,
							'project'            : resourceMetadata.project,
							'resource'           : resourceMetadata.resource,
							'savePointTimestamp' : resourceMetadata.timestamp,
							'savePointHash'      : resourceMetadata.hash
						}]
					});
				}
			});
		});
		
		this.socket.on('resourceStored', function(data) {
			var location = self._rootLocation + data.project + '/' + data.resource;
			if (self._resourceUrl === location) {
				this._resourceMetadata = data;
			}
		});
		
		this.socket.on('liveResourceChanged', function(data) {
			self._getResourceData().then(function(resourceMetadata) {
				if (data.username === resourceMetadata.username 
					&& data.project === resourceMetadata.project 
					&& data.resource === resourceMetadata.resource
					&& self._editorContext) {
						
					var text = data.addedCharacters !== undefined ? data.addedCharacters : "";
					
					muteLiveEdit = true;
					self._editorContext.setText(text, data.offset, data.offset + data.removedCharCount).then(function() {
						muteLiveEdit = false;
					}, function() {
						muteLiveEdit = false;
					});
				}
			});
		});
		
		this.socket.on('liveMetadataChanged', function (data) {
			self._getResourceData().then(function(resourceMetadata) {
				if (resourceMetadata.username === data.username 
					&& resourceMetadata.project === data.project 
					&& resourceMetadata.resource === data.resource
					&& data.problems !== undefined) {
					
					resourceMetadata.markers = [];
					var i;
					for(i = 0; i < data.problems.length; i++) {
//						var lineOffset = editor.getModel().getLineStart(data.problems[i].line - 1);
		
//						console.log(lineOffset);
		
						resourceMetadata.markers[i] = {
							'description' : data.problems[i].description,
//							'line' : data.problems[i].line,
							'severity' : data.problems[i].severity,
							'start' : /*(data.problems[i].start - lineOffset) + 1*/ data.problems[i].start,
							'end' : /*data.problems[i].end - lineOffset*/ data.problems[i].end
						};
					}
					if (serviceRegistry) {
						serviceRegistry.getService("orion.core.marker")._setProblems(resourceMetadata.markers);
					}
				}
				self._handleMessage(data);
			});			
		});
		
	}
	

	FluxEditor.prototype = /**@lends eclipse.FluxEditor.prototype */
	{
		_normalizeLocation : function(location) {
			if (!location) {
				location = "/";
			} else {
				location = location.replace(this._rootLocation, "");				
			}
			var indexOfDelimiter = location.indexOf('/');
			var project = indexOfDelimiter < 0 ? location : location.substr(0, indexOfDelimiter);
			location = indexOfDelimiter < 0 ? undefined : location.substr(indexOfDelimiter + 1);
			return { 'project' : project, 'path' : location };
		},
		sendMessage : function(type, message, callbacks) {
//			if (this._connectedToChannel) {
				if (callbacks) {
					message.callback_id = generateCallbackId();
					callbacksCache[message.callback_id] = callbacks;
				} else {
					message.callback_id = 0;
				}
				this.socket.emit(type, message);
				return true;
//			} else {
//				return false;
//			}
		},
		_handleMessage: function(data) {
			var callbacks = callbacksCache[data.callback_id];
			if (callbacks) {
				if (Array.isArray(callbacks)) {
					var fn = callbacks[0];
					fn.call(this, data);
					callbacks.shift();
					if (callbacks.length === 0) {
						delete callbacksCache[data.callback_id];
					}
					return true;
				} else if (callbacks.call) {
					callbacks.call(this, data);
					delete callbacksCache[data.callback_id];
					return true;
				}
			}
			return false;
		},
		
		_isFluxResource: function(resourceUrl) {
			return resourceUrl && resourceUrl.indexOf(this._rootLocation) === 0;
		},
		
		_getResourceData: function() {
			var request = new orion.Deferred();
			var self = this;
			if (self._resourceMetadata) {
				request.resolve(self._resourceMetadata);
			} else if (this._resourceUrl) {
				var normalizedLocation = this._normalizeLocation(this._resourceUrl);
				this.sendMessage("getResourceRequest", {
					'username' : user,
					'project' : normalizedLocation.project,
					'resource' : normalizedLocation.path,
				}, function(data) {
					var location = self._rootLocation + data.project + '/' + data.resource;
					if (self._resourceUrl === location) {
						self._resourceMetadata = data;
						request.resolve(data);
					}
				});
			} else {
				request.reject("No resource URL!");
			}
			return request;
		},
		
		_setEditorInput: function(resourceUrl, editorContext) {
			var self = this;
			if (this._resourceUrl !== resourceUrl) {
				this._resourceUrl = null;
				this._editorContext = null;
				this._resourceMetadata = null;
				if (editSession) {
					editSession.resolve();
				}
				muteLiveEdit = true;
				if (this._isFluxResource(resourceUrl)) {
					this._resourceUrl = resourceUrl;
					editSession = new orion.Deferred();
					this._editorContext = editorContext;
					muteLiveEdit = false;
					
					this._getResourceData().then(function(resourceMetadata) {
						self.sendMessage('liveResourceStarted', {
							'callback_id' : 0,
							'username' : resourceMetadata.username,
							'project' : resourceMetadata.project,
							'resource' : resourceMetadata.resource,
							'hash' : resourceMetadata.hash,
							'timestamp' : resourceMetadata.timestamp
						});	
					});				
				}
			}
			return editSession;
		},
		
		onModelChanging: function(evt) {
			console.log("Editor changing: " + JSON.stringify(evt));
			var self = this;
			if (muteLiveEdit) {
				return;
			}
			this._getResourceData().then(function(resourceMetadata) {
				var changeData = {
					'username' : resourceMetadata.username,
					'project' : resourceMetadata.project,
					'resource' : resourceMetadata.resource,
					'offset' : evt.start,
					'removedCharCount' : evt.removedCharCount,
					'addedCharacters' : evt.text,
				};
		
				self.sendMessage('liveResourceChanged', changeData);
			});
		},
		
		computeContentAssist: function(editorContext, options) {
			var request = new orion.Deferred();
			var self = this;
			this._getResourceData().then(function(resourceMetadata) {
				self.sendMessage("contentassistrequest", {
					'username' : resourceMetadata.username,
					'project' : resourceMetadata.project,
					'resource' : resourceMetadata.resource,
					'offset' : options.offset,
					'prefix' : options.prefix,
					'selection' : options.selection
				}, function(data) {
					var proposals = [];
					if (data.proposals) {
						data.proposals.forEach(function(proposal) {
							var name;
							var description;
							if (proposal.description 
								&& proposal.description.segments 
								&& (Array.isArray && Array.isArray(proposal.description.segments) || proposal.description.segments instanceof Array)) {
								
								if (proposal.description.segments.length >= 2) {
									name = proposal.description.segments[0].value;
									description = proposal.description.segments[1].value;
								} else {
									description = proposal.description.segments[0].value;
								}
							} else {
								description = proposal.description;
							}
							if (!description) {
								description = proposal.proposal;
							}
							if (description) {
								proposals.push({
									'description' : description,
									'name' : name,
									'overwrite' : proposal.replace,
									'positions' : proposal.positions,
									'proposal' : proposal.proposal,
									'style' : "emphasis",
									'escapePosition' : proposal.escapePosition
								});
							}
						});
					}
					console.log("Editor content assist: " + JSON.stringify(proposals));
					request.resolve(proposals);
				});
			});
			return request;
		},
		
		computeProblems: function(editorContext, options) {
			console.log("Validator (Problems): " + JSON.stringify(options));
			var problemsRequest = new orion.Deferred();
//			this._setEditorInput(options.title, editorContext);
			this._waitForProblemMarkers(this._resourceUrl, 50, function(markers) {
				problemsRequest.resolve(markers);
			}, function() {
				problemsRequest.reject();
			});			
			return problemsRequest;
		},
		
		startEdit: function(editorContext, options) {
			console.log("LIVE EDIT: " + JSON.stringify(options));
			var url = options ? options.title : null;
			serviceRegistry = serviceRegistry || options ? options.serviceRegistry : null;
			return this._setEditorInput(url, editorContext);
		},
		
		endEdit: function(resourceUrl) {
			this._resourceUrl = null;
			this._editorContext = null;
			this._resourceMetadata = null;
			if (editSession) {
				editSession.resolve();
			}
			muteLiveEdit = true;
		},
		
		_waitForProblemMarkers: function(resourceUrl, interval, successCallback, failureCallback) {
			var self = this;			
			var wait = function() {
				self._getResourceData().then(function(resourceMetadata) {
					if (self._resourceUrl === resourceUrl) {
						if (resourceMetadata.markers) {
							if (successCallback && successCallback.call) {
								successCallback.call(self, resourceMetadata.markers);
							}
						} else {
							setTimeout(wait, interval);
						}
					} else {
						if (failureCallback && failureCallback.call) {
							failureCallback.call(self);
						}
					}	
				});
			};
			wait.call(this);
		},
		
	};

	return FluxEditor;
}());