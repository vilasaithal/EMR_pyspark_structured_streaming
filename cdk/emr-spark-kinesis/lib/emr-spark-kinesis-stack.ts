import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as emr from 'aws-cdk-lib/aws-emr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from "path";
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import {NagSuppressions} from "cdk-nag";

export class EmrSparkKinesisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, 'VPC', {
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet-1',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-subnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }
      ],
    });

    NagSuppressions.addResourceSuppressions(vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC FLow Logs wont be used for costs purposes'
      },
    ]);

    const kinesisSourceStream = new kinesis.Stream(this, 'Kinesis Spark Source Stream', {
      streamName: 'kinesis-source',
      streamMode: kinesis.StreamMode.ON_DEMAND
    })

    const kinesisSinkStream = new kinesis.Stream(this, 'Kinesis Spark Sink Stream', {
      streamName: 'kinesis-sink',
      streamMode: kinesis.StreamMode.ON_DEMAND
    })

    // our KDA app needs to be able to log
    const kinesisPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [kinesisSourceStream.streamArn,kinesisSinkStream.streamArn],
          actions: ["kinesis:DescribeStream",
            "kinesis:GetShardIterator",
            "kinesis:GetRecords",
            "kinesis:PutRecord",
            "kinesis:PutRecords",
            "kinesis:ListShards"
          ]
        }),
      ],
    });


    const emrServiceRole = new iam.Role(this, 'EMR Service Role', {
      assumedBy: new iam.ServicePrincipal("elasticmapreduce.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonElasticMapReduceRole')],
    });

    NagSuppressions.addResourceSuppressions(emrServiceRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Need to use EMR Service Role in order to execute EMR Steps'
      },
    ]);


    const emrJobFlowRole = new iam.Role(this, 'EMR Job Flow Role', {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      inlinePolicies: {
        kinesisPolicy:kinesisPolicy
      },
      managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonElasticMapReduceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedEC2InstanceDefaultPolicy'),
      ],
    });

    NagSuppressions.addResourceSuppressions(emrJobFlowRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Need to use SSM Managed Roles for being able to use Session Manager'
      },
    ]);

    const emrInstanceProfile = new iam.CfnInstanceProfile(this, 'EMR InstanceProfile', {
      instanceProfileName: 'emr-instance-profile-spark-kinesis',
      roles: [emrJobFlowRole.roleName]
    });

    const cfnCluster = new emr.CfnCluster(this, 'EMR-Spark-Cluster', {
      jobFlowRole: emrInstanceProfile.instanceProfileName!,
      name: "emr-spark-kinesis",
      serviceRole: emrServiceRole.roleName,
      releaseLabel: 'emr-7.1.0',
      instances: {
        coreInstanceGroup: {
          instanceType: "m5.xlarge",
          instanceCount: 1,
        },
        masterInstanceGroup: {
          instanceType: "m5.xlarge",
          instanceCount: 1
        },
        ec2SubnetId: vpc.publicSubnets[0].subnetId,
      },
      applications: [{
        name: 'Spark'
      },
        {
          name: 'Hive'
        },
        {
          name: 'Hadoop'
        }],
    })

    cfnCluster.node.addDependency(emrInstanceProfile)
    cfnCluster.node.addDependency(emrServiceRole)
    cfnCluster.node.addDependency(emrJobFlowRole)

    NagSuppressions.addResourceSuppressions(cfnCluster,[
      {
        id: 'AwsSolutions-EMR2',
        reason: 'Not using S3 Logging for cost purposes'
      },
      {
        id: 'AwsSolutions-EMR4',
        reason: 'Not using local disk encryption for cost purposes'
      },
      {
        id: 'AwsSolutions-EMR5',
        reason: 'Not using encryption in transit for cost purposes'
      },
      {
        id: 'AwsSolutions-EMR6',
        reason: 'Not needed as we will be accessing through SSM'
      },
    ]);

    const cfnStreamConsumer = new kinesis.CfnStreamConsumer(this, 'MyCfnStreamConsumer', {
      consumerName: 'efo-consumer',
      streamArn: kinesisSourceStream.streamArn,
    });

  }
}

