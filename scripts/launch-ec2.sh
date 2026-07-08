#!/usr/bin/env bash
#
# Launch a hardened RebarPad EC2 instance. Encodes the security-relevant launch
# settings so they can't be forgotten on a relaunch:
#   - IMDSv2 required (HttpTokens=required) + hop limit 1   [prevents the IMDSv1 finding]
#   - encrypted gp3 root volume
#   - a real public subnet (IGW-routed) so it's reachable
#
# Reuses the existing security group / key pair / subnet by default; override via
# env vars for a new region/VPC. Prints the new instance id; associate the
# Elastic IP and run scripts/setup-host.sh afterward.
set -euo pipefail

REGION="${REGION:-us-east-1}"
SUBNET="${SUBNET:-subnet-04e0638d4e03e3be5}"   # public (IGW-routed) subnet in the default VPC
SG="${SG:-sg-02e08a2046e31ec8c}"               # interview-pad (22 from you, 80/443 world)
KEYPAIR="${KEYPAIR:-interview-pad}"
TYPE="${TYPE:-t3.small}"
DISK_GB="${DISK_GB:-30}"

# Ubuntu 22.04 LTS x86_64
AMI="$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id \
  --query Parameter.Value --output text)"

aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" --instance-type "$TYPE" \
  --key-name "$KEYPAIR" --security-group-ids "$SG" --subnet-id "$SUBNET" \
  --associate-public-ip-address \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${DISK_GB},\"VolumeType\":\"gp3\",\"Encrypted\":true}}]" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=interview-pad},{Key=Project,Value=interview-pad}]' \
  --query 'Instances[0].InstanceId' --output text
