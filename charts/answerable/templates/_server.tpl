{{/*
One server: its ServiceAccount, Deployment, Service, Ingress, HorizontalPodAutoscaler and PodDisruptionBudget.
Takes root, component (the resource name), image, port, values (its block of values), host, env (rendered variables),
readiness (the readiness path) and liveness (an HTTP path, or empty for a TCP check). Traefik streams responses as they come, which the MCP endpoints' server-sent events need.
*/}}
{{- define "answerable.server" -}}
{{- $root := .root -}}
{{- $values := .values -}}
{{- $scope := dict "root" $root "component" .component -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  {{- if not $values.autoscaling.enabled }}
  replicas: {{ $values.replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "answerable.labels" $scope | nindent 8 }}
    spec:
      serviceAccountName: {{ .component }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      {{- include "answerable.podCommon" $root | nindent 6 }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: {{ $root.Values.spreadOverNodes }}
          labelSelector:
            matchLabels:
              {{- include "answerable.selectorLabels" $scope | nindent 14 }}
      containers:
        - name: {{ .component }}
          image: {{ include "answerable.image" (dict "root" $root "name" .image) }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .port }}
          env:
            {{- .env | nindent 12 }}
            {{- include "answerable.commonEnv" $root | nindent 12 }}
            {{- range $name, $value := $values.env }}
            - name: {{ $name }}
              value: {{ $value | quote }}
            {{- end }}
          {{- with .envFrom }}
          envFrom:
            {{- . | nindent 12 }}
          {{- end }}
          startupProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 2
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            {{- if .liveness }}
            httpGet:
              path: {{ .liveness }}
              port: http
            {{- else }}
            tcpSocket:
              port: http
            {{- end }}
            periodSeconds: 10
            failureThreshold: 3
          resources:
            {{- toYaml $values.resources | nindent 12 }}
          securityContext:
            {{- include "answerable.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            {{- include "answerable.volumeMounts" $root | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "answerable.selectorLabels" $scope | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
  annotations:
    cert-manager.io/cluster-issuer: {{ $root.Values.ingress.clusterIssuer }}
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    # Only Cloudflare holds a client certificate the origin-pull CA signed (Authenticated Origin Pulls, D19).
    traefik.ingress.kubernetes.io/router.tls.options: {{ $root.Release.Namespace }}-{{ $root.Values.ingress.tlsOption }}@kubernetescrd
spec:
  ingressClassName: {{ $root.Values.ingress.className }}
  tls:
    - hosts:
        - {{ .host }}
      secretName: {{ .component }}-tls
  rules:
    - host: {{ .host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .component }}
                port:
                  name: http
{{- if $values.autoscaling.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .component }}
  minReplicas: {{ $values.autoscaling.minReplicas }}
  maxReplicas: {{ $values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
{{- end }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
{{- end -}}
